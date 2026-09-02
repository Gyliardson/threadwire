import { RuntimeLease, RuntimeLeaseSource } from "../domain/RuntimeGeneration.js";
import { CdpEndpointProvenanceSource } from "./CdpEndpointProvenance.js";

export interface ObservedRuntimeLeaseSource extends RuntimeLeaseSource {
  assertRuntimeLeaseCurrentObserved(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void>;
}

export interface RuntimeProvenanceGuard {
  bind(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void>;
  assertCurrent(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void>;
}

export class BoundRuntimeProvenanceGuard implements RuntimeProvenanceGuard {
  public constructor(
    private readonly runtime: ObservedRuntimeLeaseSource,
    private readonly endpoint: CdpEndpointProvenanceSource,
  ) {}

  public async bind(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void> {
    await this.runtime.assertRuntimeLeaseCurrentObserved(expectedLease, signal);
    await this.endpoint.bindOwnedEndpoint(expectedLease, signal);
    await this.runtime.assertRuntimeLeaseCurrentObserved(expectedLease, signal);
  }

  public async assertCurrent(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void> {
    await this.runtime.assertRuntimeLeaseCurrentObserved(expectedLease, signal);
    await this.endpoint.assertOwnedEndpointCurrent(expectedLease, signal);
    await this.runtime.assertRuntimeLeaseCurrentObserved(expectedLease, signal);
  }
}
