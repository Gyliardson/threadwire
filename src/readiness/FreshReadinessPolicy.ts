import { ExistingReadinessAction, ExistingReadinessGate, ExistingReadinessPolicy, ExistingReadinessPolicyOptions } from "./ExistingReadinessPolicy.js";
import { ExistingReadinessSnapshot, ReadinessGate } from "./types.js";

export const DEFAULT_FRESH_GUARD_DURATION_MS = 500;

export interface FreshReadinessPolicyOptions extends ExistingReadinessPolicyOptions {
  readonly guardDurationMs?: number;
  readonly clock?: () => number;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`);
  }
  return value;
}

export class FreshReadinessPolicy {
  private readonly guardDurationMs: number;
  private readonly clock: () => number;
  private readonly existingPolicy: ExistingReadinessPolicy;

  public constructor(options: FreshReadinessPolicyOptions = {}) {
    this.guardDurationMs = nonNegativeFinite(
      options.guardDurationMs ?? DEFAULT_FRESH_GUARD_DURATION_MS,
      "guardDurationMs",
    );
    this.clock = options.clock ?? Date.now;
    this.existingPolicy = new ExistingReadinessPolicy(options);
  }

  public createGate(): FreshReadinessGate {
    return new FreshReadinessGate(
      this.existingPolicy.createGate(),
      this.guardDurationMs,
      this.clock,
    );
  }
}

export class FreshReadinessGate implements ReadinessGate {
  private guardStartTime: number | null = null;

  public constructor(
    private readonly existingGate: ExistingReadinessGate,
    private readonly guardDurationMs: number,
    private readonly clock: () => number,
  ) {}

  public observe(snapshot: ExistingReadinessSnapshot): ExistingReadinessAction {
    const action = this.existingGate.observe(snapshot);

    if (action.kind !== "READY") {
      this.guardStartTime = null;
      return action;
    }

    const now = this.clock();
    if (this.guardStartTime === null) {
      this.guardStartTime = now;
    }

    if (now - this.guardStartTime >= this.guardDurationMs) {
      return { kind: "READY" };
    }

    return { kind: "WAIT" };
  }
}
