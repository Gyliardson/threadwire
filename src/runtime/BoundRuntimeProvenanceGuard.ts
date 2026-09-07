import { performance } from "node:perf_hooks";
import {
  RuntimeLease,
  RuntimeLeaseSource,
  runtimeGenerationNumber,
} from "../domain/RuntimeGeneration.js";
import { ThreadwireError, ThreadwireErrorCode } from "../domain/errors.js";
import { CdpEndpointProvenanceSource } from "./CdpEndpointProvenance.js";

export const BOUND_EXISTING_PROVENANCE_DIAGNOSTIC_PREFIX =
  "THREADWIRE_BOUND_EXISTING_PROVENANCE_DIAGNOSTIC_V1";
export const BOUND_EXISTING_PROVENANCE_DIAGNOSTIC_SCHEMA =
  "BOUND_EXISTING_PROVENANCE_DIAGNOSTIC_V1" as const;
const M2_PUBLIC_CDP_DIAGNOSTIC_ENV = "THREADWIRE_M2_PUBLIC_CDP_DIAGNOSTIC";
const MAX_DIAGNOSTIC_LINE_LENGTH = 2048;

export type RuntimeProvenanceGuardOperation = "BIND" | "ASSERT_CURRENT";
export type RuntimeProvenanceDiagnosticStage =
  | "INITIAL_RUNTIME_LEASE_OBSERVATION"
  | "ENDPOINT_LISTENER_ANCESTRY_OBSERVATION"
  | "FINAL_RUNTIME_LEASE_OBSERVATION";
export type RuntimeProvenanceDiagnosticOutcome = "PASS" | "FAIL" | "TIMEOUT" | "NOT_REACHED";
export type RuntimeProvenanceDiagnosticErrorClass = ThreadwireErrorCode | "UNCLASSIFIED_ERROR";

export interface RuntimeProvenanceDiagnosticStageResult {
  readonly stage: RuntimeProvenanceDiagnosticStage;
  readonly startElapsedMs: number | null;
  readonly finishElapsedMs: number | null;
  readonly outcome: RuntimeProvenanceDiagnosticOutcome;
  readonly errorClass: RuntimeProvenanceDiagnosticErrorClass | null;
}

export interface RuntimeProvenanceDiagnosticReport {
  readonly schema: typeof BOUND_EXISTING_PROVENANCE_DIAGNOSTIC_SCHEMA;
  readonly operation: "BOUND_EXISTING_PROVENANCE_RCA";
  readonly guardOperation: RuntimeProvenanceGuardOperation;
  readonly operationSequence: number;
  readonly leaseGeneration: number;
  readonly expectedPid: number;
  readonly stages: readonly RuntimeProvenanceDiagnosticStageResult[];
}

export type RuntimeProvenanceDiagnosticSink = (report: RuntimeProvenanceDiagnosticReport) => void;

export interface BoundRuntimeProvenanceGuardOptions {
  readonly diagnosticSink?: RuntimeProvenanceDiagnosticSink | null;
  readonly monotonicNow?: () => number;
}

export interface ObservedRuntimeLeaseSource extends RuntimeLeaseSource {
  assertRuntimeLeaseCurrentObserved(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void>;
}

export interface RuntimeProvenanceGuard {
  bind(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void>;
  assertCurrent(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void>;
}

interface MutableStageResult {
  readonly stage: RuntimeProvenanceDiagnosticStage;
  startElapsedMs: number | null;
  finishElapsedMs: number | null;
  outcome: RuntimeProvenanceDiagnosticOutcome | "RUNNING";
  errorClass: RuntimeProvenanceDiagnosticErrorClass | null;
}

interface ProvenanceStage {
  readonly stage: RuntimeProvenanceDiagnosticStage;
  readonly run: () => Promise<void>;
}

function classifyError(error: unknown): RuntimeProvenanceDiagnosticErrorClass {
  return error instanceof ThreadwireError ? error.code : "UNCLASSIFIED_ERROR";
}

function isTimeoutSignal(signal?: AbortSignal): boolean {
  return signal?.aborted === true && signal.reason instanceof ThreadwireError && signal.reason.code === "OPERATION_TIMEOUT";
}

function createEnvironmentDiagnosticSink(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  writeLine: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): RuntimeProvenanceDiagnosticSink | undefined {
  if (environment[M2_PUBLIC_CDP_DIAGNOSTIC_ENV] !== "1") {
    return undefined;
  }

  return (report) => {
    if (report.stages.every((stage) => stage.outcome === "PASS")) {
      return;
    }
    const line = `${BOUND_EXISTING_PROVENANCE_DIAGNOSTIC_PREFIX} ${JSON.stringify(report)}\n`;
    if (line.length > MAX_DIAGNOSTIC_LINE_LENGTH) {
      return;
    }
    try {
      writeLine(line);
    } catch {
      // Diagnostic delivery is strictly best-effort and may not affect product behavior.
    }
  };
}

export function createBoundExistingProvenanceDiagnosticSinkFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  writeLine: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): RuntimeProvenanceDiagnosticSink | undefined {
  return createEnvironmentDiagnosticSink(environment, writeLine);
}

export class BoundRuntimeProvenanceGuard implements RuntimeProvenanceGuard {
  private readonly diagnosticSink: RuntimeProvenanceDiagnosticSink | undefined;
  private readonly monotonicNow: () => number;
  private operationSequence = 0;

  public constructor(
    private readonly runtime: ObservedRuntimeLeaseSource,
    private readonly endpoint: CdpEndpointProvenanceSource,
    options: BoundRuntimeProvenanceGuardOptions = {},
  ) {
    this.diagnosticSink =
      options.diagnosticSink === undefined
        ? createEnvironmentDiagnosticSink()
        : (options.diagnosticSink ?? undefined);
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  public async bind(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void> {
    if (this.diagnosticSink === undefined) {
      await this.runtime.assertRuntimeLeaseCurrentObserved(expectedLease, signal);
      await this.endpoint.bindOwnedEndpoint(expectedLease, signal);
      await this.runtime.assertRuntimeLeaseCurrentObserved(expectedLease, signal);
      return;
    }

    await this.runObserved(
      "BIND",
      expectedLease,
      signal,
      () => this.endpoint.bindOwnedEndpoint(expectedLease, signal),
    );
  }

  public async assertCurrent(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void> {
    if (this.diagnosticSink === undefined) {
      await this.runtime.assertRuntimeLeaseCurrentObserved(expectedLease, signal);
      await this.endpoint.assertOwnedEndpointCurrent(expectedLease, signal);
      await this.runtime.assertRuntimeLeaseCurrentObserved(expectedLease, signal);
      return;
    }

    await this.runObserved(
      "ASSERT_CURRENT",
      expectedLease,
      signal,
      () => this.endpoint.assertOwnedEndpointCurrent(expectedLease, signal),
    );
  }

  private async runObserved(
    guardOperation: RuntimeProvenanceGuardOperation,
    expectedLease: RuntimeLease,
    signal: AbortSignal | undefined,
    endpointOperation: () => Promise<void>,
  ): Promise<void> {
    const operationStartedAt = this.monotonicNow();
    const stages: readonly ProvenanceStage[] = [
      {
        stage: "INITIAL_RUNTIME_LEASE_OBSERVATION",
        run: () => this.runtime.assertRuntimeLeaseCurrentObserved(expectedLease, signal),
      },
      {
        stage: "ENDPOINT_LISTENER_ANCESTRY_OBSERVATION",
        run: endpointOperation,
      },
      {
        stage: "FINAL_RUNTIME_LEASE_OBSERVATION",
        run: () => this.runtime.assertRuntimeLeaseCurrentObserved(expectedLease, signal),
      },
    ];
    const results: MutableStageResult[] = stages.map(({ stage }) => ({
      stage,
      startElapsedMs: null,
      finishElapsedMs: null,
      outcome: "NOT_REACHED",
      errorClass: null,
    }));
    const operationSequence = ++this.operationSequence;
    let currentStageIndex = -1;
    let reportEmitted = false;

    const elapsed = (): number => Math.max(0, this.monotonicNow() - operationStartedAt);
    const emitReport = (): void => {
      if (reportEmitted) {
        return;
      }
      reportEmitted = true;
      const report: RuntimeProvenanceDiagnosticReport = Object.freeze({
        schema: BOUND_EXISTING_PROVENANCE_DIAGNOSTIC_SCHEMA,
        operation: "BOUND_EXISTING_PROVENANCE_RCA" as const,
        guardOperation,
        operationSequence,
        leaseGeneration: runtimeGenerationNumber(expectedLease.generation),
        expectedPid: expectedLease.identity.pid,
        stages: Object.freeze(
          results.map((result) =>
            Object.freeze({
              stage: result.stage,
              startElapsedMs: result.startElapsedMs,
              finishElapsedMs: result.finishElapsedMs,
              outcome: result.outcome === "RUNNING" ? "FAIL" : result.outcome,
              errorClass: result.errorClass,
            }),
          ),
        ),
      });
      try {
        this.diagnosticSink?.(report);
      } catch {
        // Diagnostic delivery is strictly best-effort and may not affect product behavior.
      }
    };

    const onAbort = (): void => {
      if (reportEmitted || currentStageIndex < 0) {
        return;
      }
      const current = results[currentStageIndex];
      if (current?.outcome !== "RUNNING") {
        return;
      }
      current.finishElapsedMs = elapsed();
      current.outcome = isTimeoutSignal(signal) ? "TIMEOUT" : "FAIL";
      current.errorClass = classifyError(signal?.reason);
      emitReport();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (let index = 0; index < stages.length; index += 1) {
        currentStageIndex = index;
        const stage = stages[index]!;
        const result = results[index]!;
        result.startElapsedMs = elapsed();
        result.outcome = "RUNNING";
        try {
          await stage.run();
        } catch (error) {
          if (!reportEmitted) {
            result.finishElapsedMs = elapsed();
            result.outcome = isTimeoutSignal(signal) ? "TIMEOUT" : "FAIL";
            result.errorClass = classifyError(error);
            emitReport();
          }
          throw error;
        }
        result.finishElapsedMs = elapsed();
        result.outcome = "PASS";
      }
      emitReport();
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
