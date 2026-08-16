import CDP from "chrome-remote-interface";
import {
  CHATGPT_ORIGIN,
  ConversationLocator,
  createConversationLocator,
} from "../domain/ThreadIdentity.js";
import { OperationAbortedError } from "../domain/errors.js";
import {
  ExistingReadinessSnapshot,
  ReadinessEditableTarget,
} from "../readiness/types.js";
import {
  CdpTransport,
  CdpTransportConnectOptions,
  CdpTransportSession,
} from "./CdpTransport.js";

type CriClient = Awaited<ReturnType<typeof CDP>>;
type CriAxNode = Awaited<ReturnType<CriClient["Accessibility"]["getFullAXTree"]>>["nodes"][number];

export interface ChromeRemoteInterfaceTransportOptions {
  readonly connect?: (options: Readonly<{ host: string; port: number; target: string }>) => Promise<unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasFunction(value: unknown, name: string): boolean {
  return isObject(value) && typeof value[name] === "function";
}

function isCriClient(value: unknown): value is CriClient {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.close === "function" &&
    typeof value.on === "function" &&
    hasFunction(value.Page, "navigate") &&
    hasFunction(value.Page, "getFrameTree") &&
    hasFunction(value.Accessibility, "getFullAXTree") &&
    hasFunction(value.DOM, "focus") &&
    hasFunction(value.Network, "enable") &&
    hasFunction(value.Network, "requestWillBeSent") &&
    hasFunction(value.Network, "loadingFinished") &&
    hasFunction(value.Network, "loadingFailed")
  );
}

function getAxProperty(node: CriAxNode, name: string): unknown {
  return node.properties?.find((property) => property.name === name)?.value.value;
}

function axBoolean(
  node: CriAxNode,
  name: string,
): boolean {
  return getAxProperty(node, name) === true;
}

function isEditableValue(value: unknown): boolean {
  return value === true || value === "plaintext" || value === "richtext";
}

function toEligibleEditable(
  node: CriAxNode,
): ReadinessEditableTarget | null {
  const backendDOMNodeId = node.backendDOMNodeId;
  if (
    node.ignored ||
    node.role?.value !== "textbox" ||
    !Number.isSafeInteger(backendDOMNodeId) ||
    backendDOMNodeId === undefined ||
    backendDOMNodeId <= 0 ||
    !axBoolean(node, "multiline") ||
    !axBoolean(node, "focusable") ||
    !isEditableValue(getAxProperty(node, "editable")) ||
    axBoolean(node, "disabled") ||
    axBoolean(node, "readonly")
  ) {
    return null;
  }

  return Object.freeze({
    backendDOMNodeId,
    focused: axBoolean(node, "focused"),
  });
}

function routeMatchesExpected(rawUrl: string, expectedLocator: ConversationLocator): boolean {
  let normalized: ConversationLocator;
  try {
    normalized = createConversationLocator(rawUrl);
  } catch {
    return false;
  }
  return normalized === expectedLocator;
}

function isRelevantBackendUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === CHATGPT_ORIGIN && url.pathname.startsWith("/backend-api/");
  } catch {
    return false;
  }
}

class ChromeRemoteInterfaceSession implements CdpTransportSession {
  private readonly activeRelevantRequestIds = new Set<string>();
  private readonly disconnectListeners = new Set<() => void>();
  private activityEpoch = 0;
  private readinessInitialized = false;
  private readinessUnsubscribers: Array<() => unknown> = [];
  private closed = false;

  public constructor(private readonly client: CriClient) {
    this.client.on("disconnect", this.handleDisconnect);
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.disconnectListeners.clear();
    this.disposeReadinessObservation();
    await this.client.close();
  }

  public onDisconnect(listener: () => void): () => void {
    if (this.closed) {
      queueMicrotask(listener);
      return () => undefined;
    }

    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  public async initializeReadinessObservation(): Promise<void> {
    if (this.readinessInitialized) {
      return;
    }
    if (this.closed) {
      throw new Error("CDP session is closed.");
    }

    const unsubscribers = [
      this.client.Network.requestWillBeSent((event) =>
        this.onRequestWillBeSent(event.requestId, event.request.url),
      ),
      this.client.Network.loadingFinished((event) => this.onRequestSettled(event.requestId)),
      this.client.Network.loadingFailed((event) => this.onRequestSettled(event.requestId)),
    ];
    this.readinessUnsubscribers = unsubscribers;

    try {
      await this.client.Network.enable();
      this.readinessInitialized = true;
    } catch (error) {
      this.disposeReadinessObservation();
      throw error;
    }
  }

  public async navigate(url: string): Promise<void> {
    if (this.closed) {
      throw new Error("CDP session is closed.");
    }

    const result = await this.client.Page.navigate({ url });
    if (typeof result.errorText === "string" && result.errorText.length > 0) {
      throw new Error("CDP Page.navigate reported a navigation error.");
    }
  }

  public async getReadinessSnapshot(
    expectedLocator: ConversationLocator,
  ): Promise<ExistingReadinessSnapshot> {
    if (this.closed || !this.readinessInitialized) {
      throw new Error("CDP readiness observation is unavailable.");
    }

    const frameTree = await this.client.Page.getFrameTree();
    const mainFrame = frameTree.frameTree.frame;
    const axTree = await this.client.Accessibility.getFullAXTree({ frameId: mainFrame.id });
    const eligibleEditables = axTree.nodes
      .map(toEligibleEditable)
      .filter((target): target is ReadinessEditableTarget => target !== null);

    return Object.freeze({
      mainFrame: Object.freeze({
        frameId: mainFrame.id,
        loaderId: mainFrame.loaderId,
        expectedRoute: routeMatchesExpected(mainFrame.url, expectedLocator),
      }),
      eligibleEditables: Object.freeze(eligibleEditables),
      backendActivity: Object.freeze({
        activeCount: this.activeRelevantRequestIds.size,
        activityEpoch: this.activityEpoch,
      }),
    });
  }

  public async focusBackendNode(backendDOMNodeId: number): Promise<void> {
    if (this.closed) {
      throw new Error("CDP session is closed.");
    }
    await this.client.DOM.focus({ backendNodeId: backendDOMNodeId });
  }

  private readonly handleDisconnect = (): void => {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.disposeReadinessObservation();
    const listeners = [...this.disconnectListeners];
    this.disconnectListeners.clear();
    for (const listener of listeners) {
      listener();
    }
  };

  private onRequestWillBeSent(requestId: string, rawUrl: string): void {
    const relevant = isRelevantBackendUrl(rawUrl);
    const wasRelevant = this.activeRelevantRequestIds.has(requestId);

    if (relevant && !wasRelevant) {
      this.activeRelevantRequestIds.add(requestId);
      this.activityEpoch += 1;
      return;
    }

    if (!relevant && wasRelevant) {
      this.activeRelevantRequestIds.delete(requestId);
      this.activityEpoch += 1;
    }
  }

  private onRequestSettled(requestId: string): void {
    if (this.activeRelevantRequestIds.delete(requestId)) {
      this.activityEpoch += 1;
    }
  }

  private disposeReadinessObservation(): void {
    for (const unsubscribe of this.readinessUnsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // Cleanup is best-effort; no protocol payload is retained.
      }
    }
    this.activeRelevantRequestIds.clear();
    this.activityEpoch = 0;
    this.readinessInitialized = false;
  }
}

async function closeLateClient(promise: Promise<unknown>): Promise<void> {
  try {
    const late = await promise;
    if (isCriClient(late)) {
      await late.close();
    }
  } catch {
    // The caller already observed the failed/aborted attach.
  }
}

export class ChromeRemoteInterfaceTransport implements CdpTransport {
  private readonly connectClient: NonNullable<ChromeRemoteInterfaceTransportOptions["connect"]>;

  public constructor(options: ChromeRemoteInterfaceTransportOptions = {}) {
    this.connectClient = options.connect ?? (async (connectOptions) => await CDP(connectOptions));
  }

  public async connect(options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    const webSocketDebuggerUrl = options.target.webSocketDebuggerUrl;
    if (!webSocketDebuggerUrl) {
      throw new TypeError("Selected target has no WebSocket debugger URL.");
    }

    const clientPromise = this.connectClient({
      host: options.host,
      port: options.port,
      target: webSocketDebuggerUrl,
    });

    const signal = options.signal;
    if (!signal) {
      const client = await clientPromise;
      if (!isCriClient(client)) {
        throw new TypeError("chrome-remote-interface returned an invalid client.");
      }
      return new ChromeRemoteInterfaceSession(client);
    }

    if (signal.aborted) {
      void closeLateClient(clientPromise);
      throw new OperationAbortedError();
    }

    return await new Promise<CdpTransportSession>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        void closeLateClient(clientPromise);
        reject(
          new OperationAbortedError(
            undefined,
            signal.reason === undefined ? undefined : { cause: signal.reason },
          ),
        );
      };

      signal.addEventListener("abort", onAbort, { once: true });
      clientPromise.then(
        (client) => {
          if (settled) {
            return;
          }
          settled = true;
          signal.removeEventListener("abort", onAbort);
          if (!isCriClient(client)) {
            reject(new TypeError("chrome-remote-interface returned an invalid client."));
            return;
          }
          resolve(new ChromeRemoteInterfaceSession(client));
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }
}
