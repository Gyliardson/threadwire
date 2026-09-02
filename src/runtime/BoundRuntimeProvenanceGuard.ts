import { RuntimeLease, RuntimeLeaseSource } from "../domain/RuntimeGeneration.js";
import { CdpEndpointProvenanceSource } from "./CdpEndpointProvenance.js";

export interface ObservedRuntimeLeaseSource extends RuntimeLeaseSource {
  assertRuntimeLeaseCurrentObserved(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void>;
}

export interface RuntimeProvenanceGuard {
  assertCurrent(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void>;
}

export class BoundRuntimeProvenanceGuard implements RuntimeProvenanceGuard {
  public constructor(
    private readonly runtime: ObservedRuntimeLeaseSource,
    private readonly endpoint: CdpEndpointProvenanceSource,
  ) {}

  public async assertCurrent(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void> {
    await this.runtime.assertRuntimeLeaseCurrentObserved(expectedLease, signal);
    await this.endpoint.assertOwnedByRuntime(expectedLease, signal);
    await this.runtime.assertRuntimeLeaseCurrentObserved(expectedLease, signal);
  }
}
