import assert from "node:assert/strict";
import test from "node:test";
import { createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import { RuntimeGenerationTracker, RuntimeLease } from "../../src/domain/RuntimeGeneration.js";
import {
  ExistingRouteReadinessTimeoutError,
  OperationAbortedError,
  RuntimeGenerationChangedError,
} from "../../src/domain/errors.js";
import { ExistingReadinessPolicy } from "../../src/readiness/ExistingReadinessPolicy.js";
import {
  ReadinessController,
  ReadinessDeadlineScheduler,
} from "../../src/readiness/ReadinessController.js";
import {
  ExistingReadinessObservationPort,
  ExistingReadinessSnapshot,
  RouteExpectation,
} from "../../src/readiness/types.js";

const locator = createConversationLocator("https://chatgpt.com/c/synthetic-readiness");

function createRuntime(): { runtime: RuntimeGenerationTracker; lease: RuntimeLease } {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 100, creationTime: "runtime-a" });
  return { runtime, lease: runtime.getCurrentRuntimeLease() };
}

function snapshot(options: {
  focused?: boolean;
  expectedRoute?: boolean;
  activeCount?: number;
  epoch?: number;
} = {}): ExistingReadinessSnapshot {
  return {
    mainFrame: {
      frameId: "main",
      loaderId: "loader",
      expectedRoute: options.expectedRoute ?? true,
    },
    eligibleEditables: [{ backendDOMNodeId: 101, focused: options.focused ?? false }],
    backendActivity: {
      activeCount: options.activeCount ?? 0,
      activityEpoch: options.epoch ?? 0,
    },
  };
}

class QueueObservation implements ExistingReadinessObservationPort {
  public readonly focuses: number[] = [];
  public snapshotCalls = 0;
  public onSnapshot: ((call: number) => void) | null = null;
  public onFocus: (() => void) | null = null;

  public constructor(
    private readonly snapshots: readonly ExistingReadinessSnapshot[],
    private readonly fallback: ExistingReadinessSnapshot = snapshots[snapshots.length - 1] ??
      snapshot({ expectedRoute: false }),
  ) {}

  public async getReadinessSnapshot(
    _expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<ExistingReadinessSnapshot> {
    this.snapshotCalls += 1;
    this.onSnapshot?.(this.snapshotCalls);
    return this.snapshots[this.snapshotCalls - 1] ?? this.fallback;
  }

  public async focusBackendNode(
    backendDOMNodeId: number,
    _lease: RuntimeLease,
  ): Promise<void> {
    this.focuses.push(backendDOMNodeId);
    this.onFocus?.();
  }
}

function fastController(
  observation: ExistingReadinessObservationPort,
  options: { timeoutMs?: number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
): ReadinessController {
  return new ReadinessController(
    observation,
    new ExistingReadinessPolicy({ frameStableObservations: 1, focusStableObservations: 1 }),
    undefined, // freshPolicy
    {
      timeoutMs: options.timeoutMs ?? 100,
      pollIntervalMs: 0,
      sleep: options.sleep ?? (async () => undefined),
    },
  );
}

test("all aligned gate signals focus then complete without a fixed stabilization sleep", async () => {
  const { lease } = createRuntime();
  let sleepCalls = 0;
  const observation = new QueueObservation([snapshot(), snapshot({ focused: true })]);
  const controller = fastController(observation, {
    sleep: async () => {
      sleepCalls += 1;
    },
  });

  await controller.waitForExistingRoute(locator, lease);
  assert.deepEqual(observation.focuses, [101]);
  assert.equal(observation.snapshotCalls, 2);
  assert.equal(sleepCalls, 1);
});

test("aborted before start returns OperationAbortedError without observation", async () => {
  const { lease } = createRuntime();
  const observation = new QueueObservation([]);
  const controller = fastController(observation);
  const abort = new AbortController();
  abort.abort(new Error("synthetic abort detail"));

  await assert.rejects(
    () => controller.waitForExistingRoute(locator, lease, abort.signal),
    OperationAbortedError,
  );
  assert.equal(observation.snapshotCalls, 0);
  assert.deepEqual(observation.focuses, []);
});

test("abort while waiting stops further observation", async () => {
  const { lease } = createRuntime();
  const abort = new AbortController();
  const observation = new QueueObservation([], snapshot({ expectedRoute: false }));
  observation.onSnapshot = (call) => {
    if (call === 1) {
      abort.abort();
    }
  };
  const controller = fastController(observation);

  await assert.rejects(
    () => controller.waitForExistingRoute(locator, lease, abort.signal),
    OperationAbortedError,
  );
  assert.equal(observation.snapshotCalls, 1);
  assert.deepEqual(observation.focuses, []);
});

test("deadline produces stable existing-route readiness timeout without locator leakage", async () => {
  const { lease } = createRuntime();
  const observation = new QueueObservation([], snapshot({ expectedRoute: false }));
  const controller = new ReadinessController(observation, new ExistingReadinessPolicy(), undefined, {
    timeoutMs: 15,
    pollIntervalMs: 2,
  });

  await assert.rejects(
    () => controller.waitForExistingRoute(locator, lease),
    (error: unknown) =>
      error instanceof ExistingRouteReadinessTimeoutError &&
      error.code === "EXISTING_ROUTE_READINESS_TIMEOUT" &&
      !error.message.includes("synthetic-readiness"),
  );
});

test("runtime replacement while waiting is preserved and no later focus is issued", async () => {
  const { runtime, lease } = createRuntime();
  const observation = new QueueObservation([snapshot({ expectedRoute: false })]);
  observation.onSnapshot = () => {
    runtime.observe({ pid: 200, creationTime: "runtime-b" });
    runtime.assertRuntimeLeaseCurrent(lease);
  };
  const controller = fastController(observation);

  await assert.rejects(
    () => controller.waitForExistingRoute(locator, lease),
    RuntimeGenerationChangedError,
  );
  assert.deepEqual(observation.focuses, []);
});

test("replacement after focus but before final verification fails stale", async () => {
  const { runtime, lease } = createRuntime();
  const observation = new QueueObservation([snapshot(), snapshot({ focused: true })]);
  observation.onFocus = () => runtime.observe({ pid: 200, creationTime: "runtime-b" });
  observation.onSnapshot = (call) => {
    if (call > 1) {
      runtime.assertRuntimeLeaseCurrent(lease);
    }
  };
  const controller = fastController(observation);

  await assert.rejects(
    () => controller.waitForExistingRoute(locator, lease),
    RuntimeGenerationChangedError,
  );
  assert.deepEqual(observation.focuses, [101]);
});

test("deadline timer is cancelled when readiness settles successfully", async () => {
  const { lease } = createRuntime();
  const observation = new QueueObservation([snapshot(), snapshot({ focused: true })]);
  const handles: unknown[] = [];
  const cancelled: unknown[] = [];
  const scheduler: ReadinessDeadlineScheduler = {
    schedule: (_callback, _delayMs) => {
      const handle = Object.freeze({ syntheticTimer: handles.length + 1 });
      handles.push(handle);
      return handle;
    },
    cancel: (handle) => {
      cancelled.push(handle);
    },
  };
  const controller = new ReadinessController(
    observation,
    new ExistingReadinessPolicy({ frameStableObservations: 1, focusStableObservations: 1 }),
    undefined,
    {
      timeoutMs: 100,
      pollIntervalMs: 0,
      sleep: async () => undefined,
      deadlineScheduler: scheduler,
    },
  );

  await controller.waitForExistingRoute(locator, lease);

  assert.equal(handles.length, 1);
  assert.deepEqual(cancelled, handles);
});

test("no observation or focus continues after ready result settles", async () => {
  const { lease } = createRuntime();
  const observation = new QueueObservation([snapshot(), snapshot({ focused: true })]);
  const controller = fastController(observation);

  await controller.waitForExistingRoute(locator, lease);
  const snapshotCalls = observation.snapshotCalls;
  const focusCalls = observation.focuses.length;
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(observation.snapshotCalls, snapshotCalls);
  assert.equal(observation.focuses.length, focusCalls);
});
