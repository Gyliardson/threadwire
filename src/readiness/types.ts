import { ConversationLocator } from "../domain/ThreadIdentity.js";
import { RuntimeLease } from "../domain/RuntimeGeneration.js";

export interface ReadinessMainFrameState {
  readonly frameId: string;
  readonly loaderId: string;
  readonly expectedRoute: boolean;
}

export interface ReadinessEditableTarget {
  readonly backendDOMNodeId: number;
  readonly focused: boolean;
}

export interface ReadinessBackendActivity {
  readonly activeCount: number;
  readonly activityEpoch: number;
}

export interface ExistingReadinessSnapshot {
  readonly mainFrame: ReadinessMainFrameState;
  readonly eligibleEditables: readonly ReadinessEditableTarget[];
  readonly backendActivity: ReadinessBackendActivity;
}

export interface ExistingReadinessObservationPort {
  getReadinessSnapshot(
    expectedLocator: ConversationLocator,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<ExistingReadinessSnapshot>;
  focusBackendNode(
    backendDOMNodeId: number,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void>;
}
