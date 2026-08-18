import { ResponseStreamEvent } from "../response/types.js";
import {
  CdpResponseTurnTransportSession,
  CdpTurnObservationHandle,
  CdpTurnObservationOptions,
  CdpTurnObservationSnapshot,
  CdpWriteLifecycleState,
} from "./CdpTransport.js";
import { CdpResponseStreamTracker } from "./CdpResponseStreamTracker.js";
import {
  ExperimentalDataReceivedEvent,
  ExperimentalNetworkDomain,
  classifyTurnRequest,
  isSuccessfulHttpStatus,
} from "./ChromeRemoteInterfaceHelpers.js";

type ResponseTurnMethods = Pick<
  CdpResponseTurnTransportSession,
  | "armTurnObservation"
  | "getTurnObservation"
  | "takeTurnResponseEvents"
  | "discardTurnResponse"
  | "releaseTurnObservation"
>;

interface ActiveTurnObservation {
  readonly handle: CdpTurnObservationHandle;
  prepareCount: number;
  writeRequestId: string | null;
  successfulResponseObserved: boolean | null;
  selectedLegRedirected: boolean;
  lifecycle: CdpWriteLifecycleState | null;
  ambiguousWrite: boolean;
  readonly response: CdpResponseStreamTracker | null;
}

export class CdpTurnObservationTracker implements ResponseTurnMethods {
  private active: ActiveTurnObservation | null = null;

  public constructor(
    private readonly network: ExperimentalNetworkDomain,
    private readonly dataObservationAvailable: () => boolean,
  ) {}

  public armTurnObservation(options: CdpTurnObservationOptions = {}): CdpTurnObservationHandle {
    if (this.active !== null) {
      throw new Error("A CDP turn observation is already active.");
    }
    const responseRequested = options.responseStream === true;
    const handle = Object.freeze({}) as unknown as CdpTurnObservationHandle;
    this.active = {
      handle,
      prepareCount: 0,
      writeRequestId: null,
      successfulResponseObserved: null,
      selectedLegRedirected: false,
      lifecycle: null,
      ambiguousWrite: false,
      response: responseRequested
        ? new CdpResponseStreamTracker(this.network, this.dataObservationAvailable())
        : null,
    };
    return handle;
  }

  public getTurnObservation(handle: CdpTurnObservationHandle): CdpTurnObservationSnapshot {
    const observation = this.require(handle);
    if (observation.ambiguousWrite) {
      throw new Error("The scoped turn write identity became ambiguous or unsafe.");
    }

    const write =
      observation.writeRequestId === null || observation.lifecycle === null
        ? null
        : Object.freeze({ lifecycle: observation.lifecycle });
    if (observation.response === null) {
      return Object.freeze({ prepareCount: observation.prepareCount, write });
    }
    return Object.freeze({
      prepareCount: observation.prepareCount,
      write,
      response: observation.response.snapshot(),
    });
  }

  public takeTurnResponseEvents(handle: CdpTurnObservationHandle): readonly ResponseStreamEvent[] {
    return this.require(handle).response?.drain() ?? Object.freeze([]);
  }

  public discardTurnResponse(handle: CdpTurnObservationHandle): void {
    this.require(handle).response?.discard();
  }

  public releaseTurnObservation(handle: CdpTurnObservationHandle): void {
    const observation = this.active;
    if (observation === null || observation.handle !== handle) {
      return;
    }
    observation.response?.dispose();
    this.active = null;
  }

  public onRequestWillBeSent(
    requestId: string,
    rawUrl: string,
    method: string | undefined,
    redirectedFromPreviousRequest: boolean,
  ): void {
    const observation = this.active;
    if (observation === null) {
      return;
    }

    if (observation.writeRequestId === requestId) {
      if (observation.lifecycle !== "ACTIVE") {
        observation.ambiguousWrite = true;
        observation.response?.dispose();
        return;
      }
      if (!redirectedFromPreviousRequest) {
        observation.ambiguousWrite = true;
        observation.response?.dispose();
        return;
      }
      observation.selectedLegRedirected = true;
      observation.successfulResponseObserved = false;
      observation.response?.fail("INCOMPLETE");
      return;
    }

    const kind = classifyTurnRequest(rawUrl, method);
    if (kind === "PREPARE") {
      observation.prepareCount += 1;
      return;
    }
    if (kind !== "WRITE") {
      return;
    }

    if (observation.writeRequestId === null) {
      observation.writeRequestId = requestId;
      observation.successfulResponseObserved = null;
      observation.selectedLegRedirected = false;
      observation.lifecycle = "ACTIVE";
      observation.response?.select(requestId);
      return;
    }

    observation.ambiguousWrite = true;
    observation.response?.dispose();
  }

  public onResponseReceived(requestId: string, status: number): void {
    const observation = this.active;
    if (
      observation === null ||
      observation.writeRequestId !== requestId ||
      observation.lifecycle !== "ACTIVE" ||
      observation.selectedLegRedirected
    ) {
      return;
    }

    const successful = isSuccessfulHttpStatus(status);
    observation.successfulResponseObserved = successful;
    if (successful) {
      observation.response?.begin(requestId);
    }
  }

  public onDataReceived(event: ExperimentalDataReceivedEvent): void {
    this.active?.response?.onData(event);
  }

  public onRequestSettled(requestId: string, failed: boolean): void {
    const observation = this.active;
    if (
      observation === null ||
      observation.writeRequestId !== requestId ||
      observation.lifecycle !== "ACTIVE"
    ) {
      return;
    }

    observation.lifecycle =
      failed ||
      observation.selectedLegRedirected ||
      observation.successfulResponseObserved !== true
        ? "FAILED"
        : "FINISHED";
    observation.response?.onTransportSettled(
      requestId,
      failed || observation.lifecycle === "FAILED",
    );
  }

  public dispose(): void {
    this.active?.response?.dispose();
    this.active = null;
  }

  private require(handle: CdpTurnObservationHandle): ActiveTurnObservation {
    const observation = this.active;
    if (observation === null || observation.handle !== handle) {
      throw new Error("CDP turn observation handle is not active.");
    }
    return observation;
  }
}
