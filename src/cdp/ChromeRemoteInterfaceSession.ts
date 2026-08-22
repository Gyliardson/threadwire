import { ConversationLocator, createConversationLocator } from "../domain/ThreadIdentity.js";
import { ExistingReadinessSnapshot, RouteExpectation } from "../readiness/types.js";
import { NormalizedResponseStreamEvent } from "../response/types.js";
import {
  CdpFinalRenderedAssistantSnapshot,
  CdpResponseRenderBaseline,
  CdpResponseTurnTransportSession,
  CdpTurnComposerState,
  CdpTurnObservationHandle,
  CdpTurnObservationOptions,
  CdpTurnObservationSnapshot,
} from "./CdpTransport.js";
import {
  CriClient,
  EligibleComposerTarget,
  ExperimentalNetworkDomain,
  isRelevantBackendUrl,
  routeMatchesExpected,
  toEligibleComposer,
  toReadinessEditable,
} from "./ChromeRemoteInterfaceHelpers.js";
import { CdpTurnObservationTracker } from "./CdpTurnObservationTracker.js";

const MAX_FINAL_RENDERED_TEXT_CHARS = 1_048_576;
const RENDERED_MESSAGE_SELECTOR =
  '[data-message-author-role="user"],[data-message-author-role="assistant"]';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export class ChromeRemoteInterfaceSession implements CdpResponseTurnTransportSession {
  private readonly activeRelevantRequestIds = new Set<string>();
  private readonly disconnectListeners = new Set<() => void>();
  private activityEpoch = 0;
  private readinessInitialized = false;
  private readinessUnsubscribers: Array<() => unknown> = [];
  private readonly turnObservation: CdpTurnObservationTracker;
  private responseDataObservationAvailable = false;
  private closed = false;

  public constructor(private readonly client: CriClient) {
    this.turnObservation = new CdpTurnObservationTracker(
      this.client.Network as unknown as ExperimentalNetworkDomain,
      () => this.responseDataObservationAvailable,
    );
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

    const unsubscribers: Array<() => unknown> = [
      this.client.Network.requestWillBeSent((event) =>
        this.onRequestWillBeSent(
          event.requestId,
          event.request.url,
          event.request.method,
          event.redirectResponse !== undefined,
        ),
      ),
      this.client.Network.responseReceived((event) =>
        this.onResponseReceived(event.requestId, event.response.status),
      ),
      this.client.Network.loadingFinished((event) => this.onRequestSettled(event.requestId, false)),
      this.client.Network.loadingFailed((event) => this.onRequestSettled(event.requestId, true)),
    ];

    const responseNetwork = this.client.Network as unknown as ExperimentalNetworkDomain;
    if (typeof responseNetwork.dataReceived === "function") {
      unsubscribers.push(responseNetwork.dataReceived((event) => this.onDataReceived(event)));
      this.responseDataObservationAvailable = true;
    }
    this.readinessUnsubscribers = unsubscribers;

    try {
      await this.client.Network.enable({});
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

    let result: Awaited<ReturnType<CriClient["Page"]["navigate"]>>;
    try {
      result = await this.client.Page.navigate({ url });
    } catch {
      throw new Error("CDP Page.navigate command failed without retained protocol metadata.");
    }
    if (typeof result.errorText === "string" && result.errorText.length > 0) {
      throw new Error("CDP Page.navigate reported a navigation error.");
    }
  }

  public async reload(): Promise<void> {
    if (this.closed) {
      throw new Error("CDP session is closed.");
    }
    try {
      await this.client.Page.reload({ ignoreCache: false });
    } catch {
      throw new Error("CDP Page.reload command failed without retained protocol metadata.");
    }
  }

  public async getReadinessSnapshot(
    expectedRoute: RouteExpectation,
  ): Promise<ExistingReadinessSnapshot> {
    if (this.closed || !this.readinessInitialized) {
      throw new Error("CDP readiness observation is unavailable.");
    }

    const frameTree = await this.client.Page.getFrameTree();
    const mainFrame = frameTree.frameTree.frame;
    const axTree = await this.client.Accessibility.getFullAXTree({ frameId: mainFrame.id });
    const eligibleEditables = axTree.nodes
      .map(toEligibleComposer)
      .filter((target): target is EligibleComposerTarget => target !== null)
      .map(toReadinessEditable);

    return Object.freeze({
      mainFrame: Object.freeze({
        frameId: mainFrame.id,
        loaderId: mainFrame.loaderId,
        expectedRoute: routeMatchesExpected(mainFrame.url, expectedRoute),
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

  public async getTurnComposerState(
    expectedRoute: RouteExpectation,
  ): Promise<CdpTurnComposerState> {
    if (this.closed || !this.readinessInitialized) {
      throw new Error("CDP turn observation is unavailable.");
    }
    const frameTree = await this.client.Page.getFrameTree();
    const mainFrame = frameTree.frameTree.frame;
    const routeValid = routeMatchesExpected(mainFrame.url, expectedRoute);
    const axTree = await this.client.Accessibility.getFullAXTree({ frameId: mainFrame.id });
    const eligible = axTree.nodes
      .map(toEligibleComposer)
      .filter((target): target is EligibleComposerTarget => target !== null);

    if (eligible.length !== 1) {
      return Object.freeze({
        expectedRoute: routeValid,
        eligible: false,
        focused: false,
        empty: false,
      });
    }

    const target = eligible[0]!;
    return Object.freeze({
      expectedRoute: routeValid,
      eligible: true,
      focused: target.focused,
      empty: target.empty,
    });
  }

  public async captureTurnResponseRenderBaseline(): Promise<CdpResponseRenderBaseline> {
    if (this.closed || !this.readinessInitialized) {
      throw new Error("CDP response render observation is unavailable.");
    }

    const expression = `(() => {
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(RENDERED_MESSAGE_SELECTOR)}));
      let userCount = 0;
      let assistantCount = 0;
      for (const node of nodes) {
        const role = node.getAttribute("data-message-author-role");
        if (role === "user") userCount += 1;
        if (role === "assistant") assistantCount += 1;
      }
      return { userCount, assistantCount };
    })()`;

    let result: Awaited<ReturnType<CriClient["Runtime"]["evaluate"]>>;
    try {
      result = await this.client.Runtime.evaluate({ expression, returnByValue: true });
    } catch {
      throw new Error("CDP rendered response baseline observation failed.");
    }
    if (result.exceptionDetails !== undefined) {
      throw new Error("CDP rendered response baseline observation failed.");
    }

    const value = result.result.value as unknown;
    if (
      !isObject(value) ||
      !isNonNegativeSafeInteger(value.userCount) ||
      !isNonNegativeSafeInteger(value.assistantCount)
    ) {
      throw new Error("CDP rendered response baseline observation was malformed.");
    }

    return Object.freeze({
      userCount: value.userCount,
      assistantCount: value.assistantCount,
    });
  }

  public async getFinalRenderedAssistantSnapshot(
    baseline: CdpResponseRenderBaseline,
    expectedRoute: RouteExpectation,
  ): Promise<CdpFinalRenderedAssistantSnapshot | null> {
    if (this.closed || !this.readinessInitialized) {
      throw new Error("CDP final rendered response observation is unavailable.");
    }
    if (
      !isNonNegativeSafeInteger(baseline.userCount) ||
      !isNonNegativeSafeInteger(baseline.assistantCount)
    ) {
      throw new TypeError("Rendered response baseline is invalid.");
    }

    let routeValid = false;
    try {
      const frameTree = await this.client.Page.getFrameTree();
      routeValid = routeMatchesExpected(frameTree.frameTree.frame.url, expectedRoute);
    } catch {
      throw new Error("CDP final rendered response route observation failed.");
    }
    if (!routeValid) {
      return null;
    }

    const expression = `(() => {
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(RENDERED_MESSAGE_SELECTOR)}));
      const roles = nodes.map((node) => node.getAttribute("data-message-author-role"));
      const userCount = roles.filter((role) => role === "user").length;
      const assistantCount = roles.filter((role) => role === "assistant").length;
      if (userCount !== ${baseline.userCount + 1} || assistantCount !== ${baseline.assistantCount + 1}) {
        return { state: "NOT_READY" };
      }
      if (roles.length < 2 || roles[roles.length - 2] !== "user" || roles[roles.length - 1] !== "assistant") {
        return { state: "NOT_READY" };
      }
      const lastUserIndex = roles.lastIndexOf("user");
      if (lastUserIndex < 0) return { state: "NOT_READY" };
      const rolesAfterLastUser = roles.slice(lastUserIndex + 1);
      if (
        rolesAfterLastUser.filter((role) => role === "assistant").length !== 1 ||
        rolesAfterLastUser.some((role) => role === "user")
      ) {
        return { state: "NOT_READY" };
      }
      const assistantNode = nodes[nodes.length - 1];
      if (!(assistantNode instanceof HTMLElement)) return { state: "NOT_READY" };
      const text = assistantNode.innerText;
      if (typeof text !== "string" || text.trim().length === 0) return { state: "NOT_READY" };
      if (text.length > ${MAX_FINAL_RENDERED_TEXT_CHARS}) return { state: "TOO_LARGE" };
      return { state: "READY", text };
    })()`;

    let result: Awaited<ReturnType<CriClient["Runtime"]["evaluate"]>>;
    try {
      result = await this.client.Runtime.evaluate({ expression, returnByValue: true });
    } catch {
      throw new Error("CDP final rendered response observation failed.");
    }
    if (result.exceptionDetails !== undefined) {
      throw new Error("CDP final rendered response observation failed.");
    }

    const value = result.result.value as unknown;
    if (!isObject(value) || typeof value.state !== "string") {
      throw new Error("CDP final rendered response observation was malformed.");
    }
    if (value.state === "NOT_READY") {
      return null;
    }
    if (value.state === "TOO_LARGE") {
      throw new Error("The final rendered assistant response exceeded its bounded capacity.");
    }
    if (
      value.state !== "READY" ||
      typeof value.text !== "string" ||
      value.text.length === 0 ||
      value.text.length > MAX_FINAL_RENDERED_TEXT_CHARS
    ) {
      throw new Error("CDP final rendered response observation was malformed.");
    }

    return Object.freeze({ text: value.text });
  }

  public armTurnObservation(options: CdpTurnObservationOptions = {}): CdpTurnObservationHandle {
    if (this.closed || !this.readinessInitialized) {
      throw new Error("CDP turn observation is unavailable.");
    }
    return this.turnObservation.armTurnObservation(options);
  }

  public getTurnObservation(handle: CdpTurnObservationHandle): CdpTurnObservationSnapshot {
    return this.turnObservation.getTurnObservation(handle);
  }

  public takeTurnResponseEvents(handle: CdpTurnObservationHandle): readonly NormalizedResponseStreamEvent[] {
    return this.turnObservation.takeTurnResponseEvents(handle);
  }

  public discardTurnResponse(handle: CdpTurnObservationHandle): void {
    this.turnObservation.discardTurnResponse(handle);
  }

  public releaseTurnObservation(handle: CdpTurnObservationHandle): void {
    this.turnObservation.releaseTurnObservation(handle);
  }

  public async insertText(text: string): Promise<void> {
    if (this.closed) {
      throw new Error("CDP session is closed.");
    }
    try {
      await this.client.Input.insertText({ text });
    } catch {
      throw new Error("CDP insertText command failed without retained protocol metadata.");
    }
  }

  public async dispatchEnterKeyDown(): Promise<void> {
    await this.dispatchEnter("keyDown");
  }

  public async dispatchEnterKeyUp(): Promise<void> {
    await this.dispatchEnter("keyUp");
  }

  public async getCurrentConversationLocator(): Promise<ConversationLocator | null> {
    if (this.closed) {
      throw new Error("CDP session is closed.");
    }
    const frameTree = await this.client.Page.getFrameTree();
    try {
      return createConversationLocator(frameTree.frameTree.frame.url);
    } catch {
      return null;
    }
  }

  private async dispatchEnter(type: "keyDown" | "keyUp"): Promise<void> {
    if (this.closed) {
      throw new Error("CDP session is closed.");
    }
    try {
      await this.client.Input.dispatchKeyEvent({
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    } catch {
      throw new Error("CDP Enter command failed without retained protocol metadata.");
    }
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

  private onRequestWillBeSent(
    requestId: string,
    rawUrl: string,
    method: string | undefined,
    redirectedFromPreviousRequest: boolean,
  ): void {
    const relevant = isRelevantBackendUrl(rawUrl);
    const wasRelevant = this.activeRelevantRequestIds.has(requestId);
    if (relevant && !wasRelevant) {
      this.activeRelevantRequestIds.add(requestId);
      this.activityEpoch += 1;
    } else if (!relevant && wasRelevant) {
      this.activeRelevantRequestIds.delete(requestId);
      this.activityEpoch += 1;
    }
    this.turnObservation.onRequestWillBeSent(
      requestId,
      rawUrl,
      method,
      redirectedFromPreviousRequest,
    );
  }

  private onResponseReceived(requestId: string, status: number): void {
    this.turnObservation.onResponseReceived(requestId, status);
  }

  private onDataReceived(event: import("./ChromeRemoteInterfaceHelpers.js").ExperimentalDataReceivedEvent): void {
    this.turnObservation.onDataReceived(event);
  }

  private onRequestSettled(requestId: string, failed: boolean): void {
    if (this.activeRelevantRequestIds.delete(requestId)) {
      this.activityEpoch += 1;
    }
    this.turnObservation.onRequestSettled(requestId, failed);
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
    this.turnObservation.dispose();
    this.activityEpoch = 0;
    this.responseDataObservationAvailable = false;
    this.readinessInitialized = false;
  }
}
