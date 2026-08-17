import assert from "node:assert/strict";
import test from "node:test";
import {
  RuntimeGenerationTracker,
  RuntimeLease,
} from "../../src/domain/RuntimeGeneration.js";
import { OperationTimeoutError } from "../../src/domain/errors.js";
import { ExistingReadinessPolicy } from "../../src/readiness/ExistingReadinessPolicy.js";
import { FreshReadinessPolicy } from "../../src/readiness/FreshReadinessPolicy.js";
import { ReadinessController } from "../../src/readiness/ReadinessController.js";
import {
  ExistingReadinessObservationPort,
  ExistingReadinessSnapshot,
  RouteExpectation,
} from "../../src/readiness/types.js";

class MutableFreshObservation implements ExistingReadinessObservationPort {
  public frameId = "main-a";
  public loaderId = "loader-a";
  public backendDOMNodeId = 101;
  public expectedRoute = true;

  public async getReadinessSnapshot(
    _expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<ExistingReadinessSnapshot> {
    return Object.freeze({
      mainFrame: Object.freeze({
        frameId: this.frameId,
        loaderId: this.loaderId,
        expectedRoute: this.expectedRoute,
      }),
      eligibleEditables: Object.freeze([
        Object.freeze({ backendDOMNodeId: this.backendDOMNodeId, focused: true }),
      ]),
      backendActivity: Object.freeze({ activeCount: 0, activityEpoch: 1 }),
    });
  }

  public async focusBackendNode(
    _backendDOMNodeId: number,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<void> {}
}

function freshProofFixture() {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 800, creationTime: "proof-a" });
  const observation = new MutableFreshObservation();
  let freshPolicyClockCalls = 0;
  const controller = new ReadinessController(
    observation,
    new ExistingReadinessPolicy({ frameStableObservations: 1, focusStableObservations: 1 }),
    new FreshReadinessPolicy({
      frameStableObservations: 1,
      focusStableObservations: 1,
      guardDurationMs: 0,
      clock: () => {
        freshPolicyClockCalls += 1;
        return freshPolicyClockCalls;
      },
    }),
    {
      timeoutMs: 100,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    },
  );
  return {
    runtime,
    observation,
    controller,
    freshPolicyClockCalls: () => freshPolicyClockCalls,
  };
}

test("same composer and loader with changed frameId cannot reuse fresh proof", async () => {
  const f = freshProofFixture();
  const lease = f.runtime.getCurrentRuntimeLease();

  await f.controller.waitForFreshRoute(lease);
  assert.equal(f.freshPolicyClockCalls(), 1);
  f.observation.frameId = "main-b";

  await f.controller.waitForTurnComposer({ kind: "FRESH_ROOT" }, lease);
  assert.equal(f.freshPolicyClockCalls(), 2);
});

test("same composer and frame with changed loaderId cannot reuse fresh proof", async () => {
  const f = freshProofFixture();
  const lease = f.runtime.getCurrentRuntimeLease();

  await f.controller.waitForFreshRoute(lease);
  assert.equal(f.freshPolicyClockCalls(), 1);
  f.observation.loaderId = "loader-b";

  await f.controller.waitForTurnComposer({ kind: "FRESH_ROOT" }, lease);
  assert.equal(f.freshPolicyClockCalls(), 2);
});

class NeverReadyObservation implements ExistingReadinessObservationPort {
  public calls = 0;

  public async getReadinessSnapshot(
    _expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<ExistingReadinessSnapshot> {
    this.calls += 1;
    return Object.freeze({
      mainFrame: Object.freeze({
        frameId: "main",
        loaderId: "loader",
        expectedRoute: false,
      }),
      eligibleEditables: Object.freeze([]),
      backendActivity: Object.freeze({ activeCount: 0, activityEpoch: 0 }),
    });
  }

  public async focusBackendNode(
    _backendDOMNodeId: number,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<void> {}
}

test("non-ready M5 readiness deadline uses deterministic scheduling plus a macrotask yield", async () => {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 801, creationTime: "deadline-a" });
  const observation = new NeverReadyObservation();
  let deadlineCallback: (() => void) | undefined;
  let deadlineCancelled = false;

  const controller = new ReadinessController(
    observation,
    new ExistingReadinessPolicy({ frameStableObservations: 1, focusStableObservations: 1 }),
    new FreshReadinessPolicy({
      frameStableObservations: 1,
      focusStableObservations: 1,
      guardDurationMs: 0,
    }),
    {
      timeoutMs: 10,
      pollIntervalMs: 0,
      deadlineScheduler: {
        schedule: (callback) => {
          deadlineCallback = callback;
          return "deadline-handle";
        },
        cancel: () => {
          deadlineCancelled = true;
        },
      },
      sleep: async () => {
        const callback = deadlineCallback;
        deadlineCallback = undefined;
        callback?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    },
  );

  await assert.rejects(
    () => controller.waitForTurnComposer({ kind: "FRESH_ROOT" }, runtime.getCurrentRuntimeLease()),
    OperationTimeoutError,
  );
  assert.ok(observation.calls >= 1);
  assert.equal(deadlineCancelled, true);
});
