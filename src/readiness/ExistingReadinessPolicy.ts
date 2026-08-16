import { ExistingReadinessSnapshot } from "./types.js";

export const DEFAULT_EXISTING_FRAME_STABLE_OBSERVATIONS = 2;
export const DEFAULT_EXISTING_FOCUS_STABLE_OBSERVATIONS = 2;

export interface ExistingReadinessPolicyOptions {
  readonly frameStableObservations?: number;
  readonly focusStableObservations?: number;
}

export type ExistingReadinessAction =
  | Readonly<{ kind: "WAIT" }>
  | Readonly<{ kind: "FOCUS"; backendDOMNodeId: number }>
  | Readonly<{ kind: "READY" }>;

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return value;
}

export class ExistingReadinessPolicy {
  private readonly frameStableObservations: number;
  private readonly focusStableObservations: number;

  public constructor(options: ExistingReadinessPolicyOptions = {}) {
    this.frameStableObservations = positiveInteger(
      options.frameStableObservations ?? DEFAULT_EXISTING_FRAME_STABLE_OBSERVATIONS,
      "frameStableObservations",
    );
    this.focusStableObservations = positiveInteger(
      options.focusStableObservations ?? DEFAULT_EXISTING_FOCUS_STABLE_OBSERVATIONS,
      "focusStableObservations",
    );
  }

  public createGate(): ExistingReadinessGate {
    return new ExistingReadinessGate(this.frameStableObservations, this.focusStableObservations);
  }
}

export class ExistingReadinessGate {
  private frameKey: string | null = null;
  private frameStableCount = 0;
  private focusTargetId: number | null = null;
  private readyActivityEpoch: number | null = null;
  private focusStableCount = 0;

  public constructor(
    private readonly requiredFrameStableObservations: number,
    private readonly requiredFocusStableObservations: number,
  ) {}

  public observe(snapshot: ExistingReadinessSnapshot): ExistingReadinessAction {
    if (!snapshot.mainFrame.expectedRoute) {
      this.resetAll();
      return { kind: "WAIT" };
    }

    const frameKey = `${snapshot.mainFrame.frameId}\u0000${snapshot.mainFrame.loaderId}`;
    if (this.frameKey !== frameKey) {
      this.frameKey = frameKey;
      this.frameStableCount = 1;
      this.resetFocus();
    } else {
      this.frameStableCount += 1;
    }

    if (this.frameStableCount < this.requiredFrameStableObservations) {
      return { kind: "WAIT" };
    }

    if (snapshot.eligibleEditables.length !== 1) {
      this.resetFocus();
      return { kind: "WAIT" };
    }

    const target = snapshot.eligibleEditables[0]!;

    if (snapshot.backendActivity.activeCount !== 0) {
      this.resetReadyEpoch();
      if (this.focusTargetId !== target.backendDOMNodeId) {
        this.focusTargetId = null;
      }
      return { kind: "WAIT" };
    }

    if (this.focusTargetId !== target.backendDOMNodeId) {
      this.focusTargetId = target.backendDOMNodeId;
      this.resetReadyEpoch();
      return { kind: "FOCUS", backendDOMNodeId: target.backendDOMNodeId };
    }

    if (!target.focused) {
      this.resetReadyEpoch();
      return { kind: "WAIT" };
    }

    if (this.readyActivityEpoch !== snapshot.backendActivity.activityEpoch) {
      this.readyActivityEpoch = snapshot.backendActivity.activityEpoch;
      this.focusStableCount = 1;
    } else {
      this.focusStableCount += 1;
    }

    if (this.focusStableCount < this.requiredFocusStableObservations) {
      return { kind: "WAIT" };
    }

    return { kind: "READY" };
  }

  private resetAll(): void {
    this.frameKey = null;
    this.frameStableCount = 0;
    this.resetFocus();
  }

  private resetFocus(): void {
    this.focusTargetId = null;
    this.resetReadyEpoch();
  }

  private resetReadyEpoch(): void {
    this.readyActivityEpoch = null;
    this.focusStableCount = 0;
  }
}
