import { ConversationLocator } from "../domain/ThreadIdentity.js";
import { ExistingReadinessSnapshot, RouteExpectation } from "../readiness/types.js";
import { NormalizedResponseStreamEvent } from "../response/types.js";
import { CdpTargetInfo } from "./types.js";

export interface CdpTransportConnectOptions {
  readonly host: string;
  readonly port: number;
  readonly target: CdpTargetInfo;
  readonly signal?: AbortSignal;
}

declare const cdpTurnObservationBrand: unique symbol;
export type CdpTurnObservationHandle = Readonly<{
  readonly [cdpTurnObservationBrand]: true;
}>;

export interface CdpTurnComposerState {
  readonly expectedRoute: boolean;
  readonly eligible: boolean;
  readonly focused: boolean;
  readonly empty: boolean;
}

export interface CdpResponseRenderBaseline {
  readonly userCount: number;
  readonly assistantCount: number;
}

export interface CdpFinalRenderedAssistantSnapshot {
  readonly text: string;
}

export type CdpWriteLifecycleState = "ACTIVE" | "FINISHED" | "FAILED";

export interface CdpTurnWriteObservation {
  readonly lifecycle: CdpWriteLifecycleState;
}

export type CdpResponseStreamLifecycleState = "PENDING" | "STREAMING" | "COMPLETED" | "FAILED";

export type CdpResponseStreamFailureKind =
  | "UNAVAILABLE"
  | "ACTIVATION_FAILED"
  | "PARSE_FAILED"
  | "INCOMPLETE"
  | "BUFFER_OVERFLOW"
  | "CONSUMER_STOPPED";

export interface CdpTurnResponseObservation {
  readonly lifecycle: CdpResponseStreamLifecycleState;
  readonly failure: CdpResponseStreamFailureKind | null;
}

export interface CdpTurnObservationSnapshot {
  readonly prepareCount: number;
  readonly write: CdpTurnWriteObservation | null;
  readonly response?: CdpTurnResponseObservation;
}

export interface CdpTurnObservationOptions {
  readonly responseStream?: boolean;
}

export interface CdpTransportSession {
  close(): Promise<void>;
  onDisconnect(listener: () => void): () => void;
  initializeReadinessObservation(): Promise<void>;
  navigate(url: string): Promise<void>;
  getReadinessSnapshot(expectedRoute: RouteExpectation): Promise<ExistingReadinessSnapshot>;
  focusBackendNode(backendDOMNodeId: number): Promise<void>;
}

export interface CdpTurnTransportSession extends CdpTransportSession {
  getTurnComposerState(expectedRoute: RouteExpectation): Promise<CdpTurnComposerState>;
  armTurnObservation(options?: CdpTurnObservationOptions): CdpTurnObservationHandle;
  getTurnObservation(handle: CdpTurnObservationHandle): CdpTurnObservationSnapshot;
  releaseTurnObservation(handle: CdpTurnObservationHandle): void;
  insertText(text: string): Promise<void>;
  dispatchEnterKeyDown(): Promise<void>;
  dispatchEnterKeyUp(): Promise<void>;
  getCurrentConversationLocator(): Promise<ConversationLocator | null>;
}

export interface CdpResponseTurnTransportSession extends CdpTurnTransportSession {
  captureTurnResponseRenderBaseline(): Promise<CdpResponseRenderBaseline>;
  getFinalRenderedAssistantSnapshot(
    baseline: CdpResponseRenderBaseline,
    expectedRoute: RouteExpectation,
  ): Promise<CdpFinalRenderedAssistantSnapshot | null>;
  takeTurnResponseEvents(handle: CdpTurnObservationHandle): readonly NormalizedResponseStreamEvent[];
  discardTurnResponse(handle: CdpTurnObservationHandle): void;
}

export interface CdpTransport {
  connect(options: CdpTransportConnectOptions): Promise<CdpTransportSession>;
}
