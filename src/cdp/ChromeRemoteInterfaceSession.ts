import { ConversationLocator, createConversationLocator } from "../domain/ThreadIdentity.js";
import { ExistingReadinessSnapshot, RouteExpectation } from "../readiness/types.js";
import { ResponseStreamEvent } from "../response/types.js";
import {
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

  public armTurnObservation(options: CdpTurnObservationOptions = {}): CdpTurnObservationHandle {
    if (this.closed || !this.readinessInitialized) {
      throw new Error("CDP turn observation is unavailable.");
    }
    return this.turnObservation.armTurnObservation(options);
  }

  public getTurnObservation(handle: CdpTurnObservationHandle): CdpTurnObservationSnapshot {
    return this.turnObservation.getTurnObservation(handle);
  }

  public takeTurnResponseEvents(handle: CdpTurnObservationHandle): readonly ResponseStreamEvent[] {
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
