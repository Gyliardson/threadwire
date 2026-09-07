import assert from "node:assert/strict";
import test from "node:test";
import {
  RuntimeGenerationTracker,
  RuntimeLease,
  sameRuntimeLease,
} from "../../src/domain/RuntimeGeneration.js";
import {
  OperationAbortedError,
  OperationTimeoutError,
  RuntimeGenerationChangedError,
  RuntimeProvenanceUnverifiedError,
  ThreadwireError,
} from "../../src/domain/errors.js";
import {
  BoundRuntimeProvenanceGuard,
  BOUND_EXISTING_PROVENANCE_DIAGNOSTIC_PREFIX,
  ObservedRuntimeLeaseSource,
  RuntimeProvenanceDiagnosticReport,
  createBoundExistingProvenanceDiagnosticSinkFromEnvironment,
} from "../../src/runtime/BoundRuntimeProvenanceGuard.js";
import { CdpEndpointProvenanceSource } from "../../src/runtime/CdpEndpointProvenance.js";

class ObservedRuntime implements ObservedRuntimeLeaseSource {
  private readonly tracker = new RuntimeGenerationTracker();
  public calls = 0;
  public readonly events: string[];
  public onObserved: ((call: number, signal?: AbortSignal) => Promise<void>) | null = null;

  public constructor(events: string[]) {
    this.events = events;
    this.tracker.observe({ pid: 100, creationTime: "runtime-a" });
  }

  public get lease(): RuntimeLease {
    return this.tracker.getCurrentRuntimeLease();
  }

  public getCurrentRuntimeLease(): RuntimeLease {
    return this.lease;
  }

  public assertRuntimeLeaseCurrent(expectedLease: RuntimeLease): void {
    if (!sameRuntimeLease(this.lease, expectedLease)) {
      throw new RuntimeGenerationChangedError();
    }
  }

  public async assertRuntimeLeaseCurrentObserved(
    expectedLease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<void> {
    this.calls += 1;
    this.events.push(`runtime:${this.calls}`);
    await this.onObserved?.(this.calls, _signal);
    this.assertRuntimeLeaseCurrent(expectedLease);
  }
}

class Endpoint implements CdpEndpointProvenanceSource {
  public bindCalls = 0;
  public assertCalls = 0;
  public readonly events: string[];
  public bindFailure: Error | null = null;
  public onBind: ((signal?: AbortSignal) => Promise<void>) | null = null;

  public constructor(events: string[]) {
    this.events = events;
  }

  public async bindOwnedEndpoint(_lease: RuntimeLease, signal?: AbortSignal): Promise<void> {
    this.bindCalls += 1;
    this.events.push("endpoint:bind");
    if (this.bindFailure !== null) {
      throw this.bindFailure;
    }
    await this.onBind?.(signal);
  }

  public async assertOwnedEndpointCurrent(_lease: RuntimeLease, _signal?: AbortSignal): Promise<void> {
    this.assertCalls += 1;
    this.events.push("endpoint:assert");
  }
}

function fixture(options: {
  readonly sink?: (report: RuntimeProvenanceDiagnosticReport) => void;
  readonly now?: () => number;
} = {}) {
  const events: string[] = [];
  const runtime = new ObservedRuntime(events);
  const endpoint = new Endpoint(events);
  const reports: RuntimeProvenanceDiagnosticReport[] = [];
  const guard = new BoundRuntimeProvenanceGuard(runtime, endpoint, {
    diagnosticSink: options.sink ?? ((report) => reports.push(report)),
    ...(options.now ? { monotonicNow: options.now } : {}),
  });
  return { events, runtime, endpoint, reports, guard };
}

function assertReachedTimingsMonotonic(report: RuntimeProvenanceDiagnosticReport): void {
  let prior = 0;
  for (const stage of report.stages) {
    if (stage.startElapsedMs === null || stage.finishElapsedMs === null) {
      continue;
    }
    assert.ok(stage.startElapsedMs >= prior);
    assert.ok(stage.finishElapsedMs >= stage.startElapsedMs);
    prior = stage.finishElapsedMs;
  }
}

test("diagnostic preserves successful stage order and behavior with monotonic elapsed values", async () => {
  let tick = 100;
  const f = fixture({ now: () => tick++ });
  const result = await f.guard.bind(f.runtime.lease);

  assert.equal(result, undefined);
  assert.deepEqual(f.events, ["runtime:1", "endpoint:bind", "runtime:2"]);
  assert.equal(f.runtime.calls, 2);
  assert.equal(f.endpoint.bindCalls, 1);
  assert.equal(f.reports.length, 1);
  const report = f.reports[0]!;
  assert.equal(report.guardOperation, "BIND");
  assert.equal(report.operationSequence, 1);
  assert.equal(report.leaseGeneration, 1);
  assert.equal(report.expectedPid, 100);
  assert.deepEqual(
    report.stages.map(({ stage, outcome, errorClass }) => ({ stage, outcome, errorClass })),
    [
      { stage: "INITIAL_RUNTIME_LEASE_OBSERVATION", outcome: "PASS", errorClass: null },
      { stage: "ENDPOINT_LISTENER_ANCESTRY_OBSERVATION", outcome: "PASS", errorClass: null },
      { stage: "FINAL_RUNTIME_LEASE_OBSERVATION", outcome: "PASS", errorClass: null },
    ],
  );
  assertReachedTimingsMonotonic(report);
});

test("diagnostic failure remains fail-closed, marks later work NOT_REACHED, and adds no retry", async () => {
  const f = fixture();
  f.endpoint.bindFailure = new RuntimeProvenanceUnverifiedError("hostile secret must not escape");

  await assert.rejects(() => f.guard.bind(f.runtime.lease), RuntimeProvenanceUnverifiedError);

  assert.deepEqual(f.events, ["runtime:1", "endpoint:bind"]);
  assert.equal(f.runtime.calls, 1);
  assert.equal(f.endpoint.bindCalls, 1);
  assert.equal(f.reports.length, 1);
  const report = f.reports[0]!;
  assert.deepEqual(
    report.stages.map(({ outcome, errorClass }) => ({ outcome, errorClass })),
    [
      { outcome: "PASS", errorClass: null },
      { outcome: "FAIL", errorClass: "RUNTIME_PROVENANCE_UNVERIFIED" },
      { outcome: "NOT_REACHED", errorClass: null },
    ],
  );
  assert.equal(report.stages[2]!.startElapsedMs, null);
  assert.equal(report.stages[2]!.finishElapsedMs, null);
  assert.doesNotMatch(JSON.stringify(report), /hostile secret/);
  assertReachedTimingsMonotonic(report);
});

test("outer timeout is synchronously classified at the active stage without a new stage budget", async () => {
  const f = fixture();
  const controller = new AbortController();
  let bindStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    bindStarted = resolve;
  });
  f.endpoint.onBind = async (signal?: AbortSignal): Promise<void> => {
    bindStarted();
    await new Promise<void>((_resolve, reject) => {
      const onAbort = (): void => reject(signal?.reason ?? new Error("aborted"));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  const pending = f.guard.bind(f.runtime.lease, controller.signal);
  await started;
  controller.abort(new OperationTimeoutError("outer 5000 ms provenance timeout"));
  await assert.rejects(() => pending, OperationTimeoutError);

  assert.equal(f.endpoint.bindCalls, 1);
  assert.equal(f.runtime.calls, 1);
  assert.equal(f.reports.length, 1);
  assert.deepEqual(
    f.reports[0]!.stages.map(({ outcome, errorClass }) => ({ outcome, errorClass })),
    [
      { outcome: "PASS", errorClass: null },
      { outcome: "TIMEOUT", errorClass: "OPERATION_TIMEOUT" },
      { outcome: "NOT_REACHED", errorClass: null },
    ],
  );
});

test("hostile runtime ThreadwireError code collapses to a fixed safe fallback while valid codes remain canonical", async () => {
  const canary = "SENSITIVE_RUNTIME_CODE_CANARY";
  const lines: string[] = [];
  const sink = createBoundExistingProvenanceDiagnosticSinkFromEnvironment(
    { THREADWIRE_M2_PUBLIC_CDP_DIAGNOSTIC: "1" },
    (line) => lines.push(line),
  );
  assert.ok(sink);
  const hostileFixture = fixture({ sink });
  const hostile = new ThreadwireError("sensitive message canary", "OPERATION_ABORTED");
  Object.defineProperty(hostile, "code", { value: canary });
  hostileFixture.endpoint.bindFailure = hostile;

  await assert.rejects(() => hostileFixture.guard.bind(hostileFixture.runtime.lease), (error) => error === hostile);

  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /"errorClass":"UNCLASSIFIED_ERROR"/);
  assert.doesNotMatch(lines[0]!, new RegExp(canary));
  assert.doesNotMatch(lines[0]!, /sensitive message canary/);

  const validFixture = fixture();
  validFixture.endpoint.bindFailure = new RuntimeProvenanceUnverifiedError();
  await assert.rejects(() => validFixture.guard.bind(validFixture.runtime.lease), RuntimeProvenanceUnverifiedError);
  assert.equal(validFixture.reports[0]!.stages[1]!.errorClass, "RUNTIME_PROVENANCE_UNVERIFIED");
});

test("provenance diagnostic sink failure cannot replace the authoritative product failure or add work", async () => {
  const productFailure = new RuntimeProvenanceUnverifiedError("authoritative failure");
  const f = fixture({
    sink: () => {
      throw new Error("diagnostic sink failure");
    },
  });
  f.endpoint.bindFailure = productFailure;

  await assert.rejects(() => f.guard.bind(f.runtime.lease), (error) => error === productFailure);
  assert.deepEqual(f.events, ["runtime:1", "endpoint:bind"]);
  assert.equal(f.runtime.calls, 1);
  assert.equal(f.endpoint.bindCalls, 1);
});

test("outer timeout during stage 1 attributes TIMEOUT only to stage 1 and does not retry", async () => {
  const f = fixture();
  const controller = new AbortController();
  let started!: () => void;
  const stageStarted = new Promise<void>((resolve) => { started = resolve; });
  f.runtime.onObserved = async (call, signal) => {
    if (call !== 1) return;
    started();
    await new Promise<void>((_resolve, reject) => {
      const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  const pending = f.guard.bind(f.runtime.lease, controller.signal);
  await stageStarted;
  controller.abort(new OperationTimeoutError());
  await assert.rejects(() => pending, OperationTimeoutError);

  assert.deepEqual(f.events, ["runtime:1"]);
  assert.equal(f.endpoint.bindCalls, 0);
  assert.deepEqual(f.reports[0]!.stages.map(({ outcome }) => outcome), ["TIMEOUT", "NOT_REACHED", "NOT_REACHED"]);
});

test("outer timeout during stage 3 preserves stages 1 and 2 as PASS and does not retry", async () => {
  const f = fixture();
  const controller = new AbortController();
  let started!: () => void;
  const stageStarted = new Promise<void>((resolve) => { started = resolve; });
  f.runtime.onObserved = async (call, signal) => {
    if (call !== 2) return;
    started();
    await new Promise<void>((_resolve, reject) => {
      const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  const pending = f.guard.bind(f.runtime.lease, controller.signal);
  await stageStarted;
  controller.abort(new OperationTimeoutError());
  await assert.rejects(() => pending, OperationTimeoutError);

  assert.deepEqual(f.events, ["runtime:1", "endpoint:bind", "runtime:2"]);
  assert.equal(f.runtime.calls, 2);
  assert.equal(f.endpoint.bindCalls, 1);
  assert.deepEqual(f.reports[0]!.stages.map(({ outcome }) => outcome), ["PASS", "PASS", "TIMEOUT"]);
});

test("non-timeout abort is not mislabeled TIMEOUT and the cancellation remains authoritative", async () => {
  const f = fixture();
  const controller = new AbortController();
  const cancellation = new OperationAbortedError("sensitive cancellation canary");
  let started!: () => void;
  const stageStarted = new Promise<void>((resolve) => { started = resolve; });
  f.endpoint.onBind = async (signal) => {
    started();
    await new Promise<void>((_resolve, reject) => {
      const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  const pending = f.guard.bind(f.runtime.lease, controller.signal);
  await stageStarted;
  controller.abort(cancellation);
  await assert.rejects(() => pending, (error) => error === cancellation);

  assert.deepEqual(f.reports[0]!.stages.map(({ outcome, errorClass }) => ({ outcome, errorClass })), [
    { outcome: "PASS", errorClass: null },
    { outcome: "FAIL", errorClass: "OPERATION_ABORTED" },
    { outcome: "NOT_REACHED", errorClass: null },
  ]);
  assert.doesNotMatch(JSON.stringify(f.reports[0]), /sensitive cancellation canary/);
});

test("already-aborted entry performs no later-stage work and retains no sensitive abort text", async () => {
  const f = fixture();
  const controller = new AbortController();
  const cancellation = new OperationAbortedError("ENTRY_SENSITIVE_CANARY");
  controller.abort(cancellation);
  f.runtime.onObserved = async (_call, signal) => {
    if (signal?.aborted) throw signal.reason;
  };

  await assert.rejects(() => f.guard.bind(f.runtime.lease, controller.signal), (error) => error === cancellation);

  assert.deepEqual(f.events, ["runtime:1"]);
  assert.equal(f.endpoint.bindCalls, 0);
  assert.deepEqual(f.reports[0]!.stages.map(({ outcome }) => outcome), ["FAIL", "NOT_REACHED", "NOT_REACHED"]);
  assert.doesNotMatch(JSON.stringify(f.reports[0]), /ENTRY_SENSITIVE_CANARY/);
});

test("abort at the stage transition cannot relabel a completed prior stage or shift attribution backward", async () => {
  const f = fixture();
  const controller = new AbortController();
  const timeout = new OperationTimeoutError();
  f.endpoint.onBind = async (signal) => {
    controller.abort(timeout);
    throw signal?.reason;
  };

  await assert.rejects(() => f.guard.bind(f.runtime.lease, controller.signal), (error) => error === timeout);

  assert.deepEqual(f.events, ["runtime:1", "endpoint:bind"]);
  assert.deepEqual(f.reports[0]!.stages.map(({ outcome }) => outcome), ["PASS", "TIMEOUT", "NOT_REACHED"]);
});

test("completed operations remove abort listeners and sequential report state remains isolated", async () => {
  const f = fixture();
  const first = new AbortController();
  const second = new AbortController();

  await f.guard.bind(f.runtime.lease, first.signal);
  assert.equal(f.reports.length, 1);
  first.abort(new OperationTimeoutError("stale completed operation"));
  assert.equal(f.reports.length, 1);

  await f.guard.bind(f.runtime.lease, second.signal);
  assert.equal(f.reports.length, 2);
  assert.equal(f.reports[0]!.operationSequence, 1);
  assert.equal(f.reports[1]!.operationSequence, 2);
  assert.deepEqual(f.reports[1]!.stages.map(({ outcome }) => outcome), ["PASS", "PASS", "PASS"]);
  assert.deepEqual(f.events, [
    "runtime:1", "endpoint:bind", "runtime:2",
    "runtime:3", "endpoint:bind", "runtime:4",
  ]);
});

test("environment sink is exact opt-in, bounded, fixed-schema, and suppresses all-pass noise", () => {
  const lines: string[] = [];
  assert.equal(createBoundExistingProvenanceDiagnosticSinkFromEnvironment({}, (line) => lines.push(line)), undefined);
  const sink = createBoundExistingProvenanceDiagnosticSinkFromEnvironment(
    { THREADWIRE_M2_PUBLIC_CDP_DIAGNOSTIC: "1" },
    (line) => lines.push(line),
  );
  assert.ok(sink);

  const passing = {
    schema: "BOUND_EXISTING_PROVENANCE_DIAGNOSTIC_V1" as const,
    operation: "BOUND_EXISTING_PROVENANCE_RCA" as const,
    guardOperation: "BIND" as const,
    operationSequence: 1,
    leaseGeneration: 1,
    expectedPid: 100,
    stages: [
      { stage: "INITIAL_RUNTIME_LEASE_OBSERVATION" as const, startElapsedMs: 0, finishElapsedMs: 1, outcome: "PASS" as const, errorClass: null },
      { stage: "ENDPOINT_LISTENER_ANCESTRY_OBSERVATION" as const, startElapsedMs: 1, finishElapsedMs: 2, outcome: "PASS" as const, errorClass: null },
      { stage: "FINAL_RUNTIME_LEASE_OBSERVATION" as const, startElapsedMs: 2, finishElapsedMs: 3, outcome: "PASS" as const, errorClass: null },
    ],
  } satisfies RuntimeProvenanceDiagnosticReport;
  sink(passing);
  assert.equal(lines.length, 0);

  sink({
    ...passing,
    stages: [
      passing.stages[0]!,
      { ...passing.stages[1]!, finishElapsedMs: 5000, outcome: "TIMEOUT", errorClass: "OPERATION_TIMEOUT" },
      { ...passing.stages[2]!, startElapsedMs: null, finishElapsedMs: null, outcome: "NOT_REACHED" },
    ],
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, new RegExp(`^${BOUND_EXISTING_PROVENANCE_DIAGNOSTIC_PREFIX} \\{`));
  assert.ok(lines[0]!.length <= 2048);
  assert.doesNotMatch(lines[0]!, /creationTime|message|stack|secret|url|commandLine/i);
});
