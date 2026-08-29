import {
  CdpFinalRenderedAssistantSnapshot,
  CdpResponseRenderBaseline,
  CdpTurnComposerState,
  CdpTurnObservationHandle,
  CdpTurnObservationOptions,
  CdpTurnObservationSnapshot,
} from "../cdp/CdpTransport.js";
import { RuntimeLease } from "../domain/RuntimeGeneration.js";
import { ConversationLocator, ThreadHandle } from "../domain/ThreadIdentity.js";
import { ProjectLocator } from "../domain/ProjectIdentity.js";
import { RouteExpectation } from "../readiness/types.js";
import { NormalizedResponseStreamEvent, ResponseStreamEvent } from "../response/types.js";

export type TurnTarget =
  | Readonly<{ kind: "THREAD"; threadHandle: ThreadHandle }>
  | Readonly<{ kind: "FRESH" }>
  | Readonly<{ kind: "PROJECT"; projectLocator: ProjectLocator }>;

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

export type TurnResponseEventListener = (event: ResponseStreamEvent) => void;

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
  captureTurnResponseRenderBaseline?(
    lease: RuntimeLease,
  ): Promise<CdpResponseRenderBaseline>;
  getFinalRenderedAssistantSnapshot?(
    baseline: CdpResponseRenderBaseline,
    expectedRoute: RouteExpectation,
    lease: RuntimeLease,
  ): Promise<CdpFinalRenderedAssistantSnapshot | null>;
  armTurnObservation(
    lease: RuntimeLease,
    options?: CdpTurnObservationOptions,
  ): CdpTurnObservationHandle;
  getTurnObservation(
    handle: CdpTurnObservationHandle,
    lease: RuntimeLease,
  ): CdpTurnObservationSnapshot;
  takeTurnResponseEvents?(
    handle: CdpTurnObservationHandle,
    lease: RuntimeLease,
  ): readonly NormalizedResponseStreamEvent[];
  discardTurnResponse?(handle: CdpTurnObservationHandle, lease: RuntimeLease): void;
  releaseTurnObservation(handle: CdpTurnObservationHandle): void;
  insertText(text: string, lease: RuntimeLease): Promise<void>;
  insertTextIntoProjectComposer?(
    text: string,
    projectLocator: ProjectLocator,
    backendDOMNodeId: number,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<number>;
  dispatchEnterKeyDown(lease: RuntimeLease): Promise<void>;
  dispatchEnterKeyUp(lease: RuntimeLease): Promise<void>;
  clickTurnSendButton?(
    projectLocator: ProjectLocator,
    backendDOMNodeId: number,
    formBackendDOMNodeId: number,
    expectedText: string,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void>;
  getCurrentConversationLocator(lease: RuntimeLease): Promise<ConversationLocator | null>;
}
