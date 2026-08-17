import {
  CdpTurnComposerState,
  CdpTurnObservationHandle,
  CdpTurnObservationSnapshot,
} from "../cdp/CdpTransport.js";
import { RuntimeLease } from "../domain/RuntimeGeneration.js";
import { ConversationLocator, ThreadHandle } from "../domain/ThreadIdentity.js";
import { RouteExpectation } from "../readiness/types.js";

export type TurnTarget =
  | Readonly<{ kind: "THREAD"; threadHandle: ThreadHandle }>
  | Readonly<{ kind: "FRESH" }>;

export type ExistingTurnResult = Readonly<{
  kind: "THREAD";
  threadHandle: ThreadHandle;
  created: false;
}>;

export type FreshTurnResult = Readonly<{
  kind: "THREAD";
  threadHandle: ThreadHandle;
  created: true;
}>;

export type TurnResult = ExistingTurnResult | FreshTurnResult;

export interface TurnComposerPreflightPort {
  waitForTurnComposer(
    expectedRoute: RouteExpectation,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface TurnCdpPort {
  getTurnComposerState(
    expectedRoute: RouteExpectation,
    lease: RuntimeLease,
  ): Promise<CdpTurnComposerState>;
  armTurnObservation(lease: RuntimeLease): CdpTurnObservationHandle;
  getTurnObservation(
    handle: CdpTurnObservationHandle,
    lease: RuntimeLease,
  ): CdpTurnObservationSnapshot;
  releaseTurnObservation(handle: CdpTurnObservationHandle): void;
  insertText(text: string, lease: RuntimeLease): Promise<void>;
  dispatchEnterKeyDown(lease: RuntimeLease): Promise<void>;
  dispatchEnterKeyUp(lease: RuntimeLease): Promise<void>;
  getCurrentConversationLocator(lease: RuntimeLease): Promise<ConversationLocator | null>;
}
