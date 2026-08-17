import { ConversationLocator } from "../domain/ThreadIdentity.js";
import { ExistingReadinessSnapshot, RouteExpectation } from "../readiness/types.js";
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

declare const cdpResponseObservationBrand: unique symbol;
export type CdpResponseObservationHandle = Readonly<{
  readonly [cdpResponseObservationBrand]: true;
}>;

export interface CdpTurnComposerState {
  readonly eligible: boolean;
  readonly focused: boolean;
  readonly empty: boolean;
}

export type CdpWriteLifecycleState = "ACTIVE" | "FINISHED" | "FAILED";

export interface CdpTurnWriteObservation {
  readonly responseHandle: CdpResponseObservationHandle;
  readonly lifecycle: CdpWriteLifecycleState;
}

export interface CdpTurnObservationSnapshot {
  readonly prepareCount: number;
  readonly write: CdpTurnWriteObservation | null;
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
  getTurnComposerState(): Promise<CdpTurnComposerState>;
  armTurnObservation(): CdpTurnObservationHandle;
  getTurnObservation(handle: CdpTurnObservationHandle): CdpTurnObservationSnapshot;
  releaseTurnObservation(handle: CdpTurnObservationHandle): void;
  insertText(text: string): Promise<void>;
  dispatchEnterKeyDown(): Promise<void>;
  dispatchEnterKeyUp(): Promise<void>;
  getCurrentConversationLocator(): Promise<ConversationLocator | null>;
}

export interface CdpTransport {
  connect(options: CdpTransportConnectOptions): Promise<CdpTransportSession>;
}
