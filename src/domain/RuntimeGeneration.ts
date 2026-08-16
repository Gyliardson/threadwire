import { RuntimeGenerationChangedError, RuntimeNotObservedError } from "./errors.js";

declare const runtimeGenerationBrand: unique symbol;
export type RuntimeGeneration = number & { readonly [runtimeGenerationBrand]: "RuntimeGeneration" };

export const INITIAL_RUNTIME_GENERATION = 0 as RuntimeGeneration;

export interface RuntimeIdentity {
  readonly pid: number;
  readonly creationTime: string;
}

declare const runtimeLeaseBrand: unique symbol;
export type RuntimeLease = Readonly<{
  generation: RuntimeGeneration;
  identity: RuntimeIdentity;
  readonly [runtimeLeaseBrand]: true;
}>;

export interface RuntimeLeaseSource {
  getCurrentRuntimeLease(): RuntimeLease;
  assertRuntimeLeaseCurrent(lease: RuntimeLease): void;
}

export function runtimeGenerationNumber(generation: RuntimeGeneration): number {
  return generation;
}

export function sameRuntimeIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.pid === right.pid && left.creationTime === right.creationTime;
}

export function sameRuntimeLease(left: RuntimeLease, right: RuntimeLease): boolean {
  return left.generation === right.generation && sameRuntimeIdentity(left.identity, right.identity);
}

function incrementGeneration(generation: RuntimeGeneration): RuntimeGeneration {
  return (runtimeGenerationNumber(generation) + 1) as RuntimeGeneration;
}

export class RuntimeGenerationTracker implements RuntimeLeaseSource {
  private generation: RuntimeGeneration = INITIAL_RUNTIME_GENERATION;
  private currentIdentity: RuntimeIdentity | null = null;
  private lastIdentity: RuntimeIdentity | null = null;

  public get currentGeneration(): RuntimeGeneration {
    return this.generation;
  }

  public observe(identity: RuntimeIdentity | null): RuntimeGeneration {
    if (identity === null) {
      this.currentIdentity = null;
      return this.generation;
    }

    if (this.lastIdentity === null) {
      this.generation = incrementGeneration(this.generation);
    } else if (!sameRuntimeIdentity(this.lastIdentity, identity)) {
      this.generation = incrementGeneration(this.generation);
    }

    this.currentIdentity = { ...identity };
    this.lastIdentity = { ...identity };
    return this.generation;
  }

  public getCurrentRuntimeLease(): RuntimeLease {
    if (this.currentIdentity === null || this.generation === INITIAL_RUNTIME_GENERATION) {
      throw new RuntimeNotObservedError();
    }

    return {
      generation: this.generation,
      identity: { ...this.currentIdentity },
    } as RuntimeLease;
  }

  public assertRuntimeLeaseCurrent(lease: RuntimeLease): void {
    const current = this.getCurrentRuntimeLease();
    if (!sameRuntimeLease(current, lease)) {
      throw new RuntimeGenerationChangedError();
    }
  }
}
