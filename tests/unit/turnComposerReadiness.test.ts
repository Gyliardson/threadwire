import assert from "node:assert/strict";
import test from "node:test";
import {
  RuntimeGenerationTracker,
  RuntimeLease,
} from "../../src/domain/RuntimeGeneration.js";
import { createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import { ExistingReadinessPolicy } from "../../src/readiness/ExistingReadinessPolicy.js";
import {
  DEFAULT_FRESH_GUARD_DURATION_MS,
  FreshReadinessPolicy,
} from "../../src/readiness/FreshReadinessPolicy.js";
import { ReadinessController } from "../../src/readiness/ReadinessController.js";
import {
  ExistingReadinessObservationPort,
  ExistingReadinessSnapshot,
  RouteExpectation,
} from "../../src/readiness/types.js";

const readySnapshot: ExistingReadinessSnapshot = Object.freeze({
  mainFrame: Object.freeze({
    frameId: "main",
    loaderId: "loader-stable",
    expectedRoute: true,
  }),
  eligibleEditables: Object.freeze([
    Object.freeze({ backendDOMNodeId: 101, focused: true }),
  ]),
  backendActivity: Object.freeze({ activeCount: 0, activityEpoch: 1 }),
});

class RecordingObservation implements ExistingReadinessObservationPort {
  public readonly expectations: RouteExpectation[] = [];
  public focusCalls = 0;

  public async getReadinessSnapshot(
    expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<ExistingReadinessSnapshot> {
    this.expectations.push(expectedRoute);
    return readySnapshot;
  }

  public async focusBackendNode(
    _backendDOMNodeId: number,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<void> {
    this.focusCalls += 1;
  }
}

function runtimeFixture(): { runtime: RuntimeGenerationTracker; lease: RuntimeLease } {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 100, creationTime: "runtime-a" });
  return { runtime, lease: runtime.getCurrentRuntimeLease() };
}

test("fresh readiness keeps the 500 ms engineering default", () => {
  assert.equal(DEFAULT_FRESH_GUARD_DURATION_MS, 500);
});

test("matching one-shot M4 fresh proof avoids blindly repeating the fresh guard during M5 preflight", async () => {
  const { lease } = runtimeFixture();
  const observation = new RecordingObservation();
  let freshClockCalls = 0;
  const controller = new ReadinessController(
    observation,
    new ExistingReadinessPolicy({ frameStableObservations: 1, focusStableObservations: 1 }),
    new FreshReadinessPolicy({
      frameStableObservations: 1,
      focusStableObservations: 1,
      guardDurationMs: 0,
      clock: () => {
        freshClockCalls += 1;
        return 1;
      },
    }),
    {
      timeoutMs: 100,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    },
  );

  await controller.waitForFreshRoute(lease);
  assert.equal(freshClockCalls, 1);

  await controller.waitForTurnComposer({ kind: "FRESH_ROOT" }, lease);
  assert.equal(
    freshClockCalls,
    1,
    "same-lease same-document proof should permit the smaller current composer revalidation",
  );

  await controller.waitForTurnComposer({ kind: "FRESH_ROOT" }, lease);
  assert.equal(
    freshClockCalls,
    2,
    "proof is one-shot; an arbitrary later FRESH assertion must re-enter the fresh policy",
  );
});

test("THREAD turn preflight preserves existing-route expectation semantics", async () => {
  const { lease } = runtimeFixture();
  const observation = new RecordingObservation();
  let freshClockCalls = 0;
  const controller = new ReadinessController(
    observation,
    new ExistingReadinessPolicy({ frameStableObservations: 1, focusStableObservations: 1 }),
    new FreshReadinessPolicy({
      frameStableObservations: 1,
      focusStableObservations: 1,
      guardDurationMs: 0,
      clock: () => {
        freshClockCalls += 1;
        return 1;
      },
    }),
    {
      timeoutMs: 100,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    },
  );
  const locator = createConversationLocator("https://chatgpt.com/c/synthetic-thread");

  await controller.waitForTurnComposer({ kind: "THREAD", locator }, lease);

  assert.equal(observation.expectations.at(-1)?.kind, "THREAD");
  assert.equal(freshClockCalls, 0);
  assert.equal(
    observation.focusCalls,
    1,
    "existing readiness adopts the unique backend node through its normal focus action",
  );
});

test("fresh proof from an old runtime generation is never reused by the replacement runtime", async () => {
  const { runtime, lease: oldLease } = runtimeFixture();
  const observation = new RecordingObservation();
  let freshClockCalls = 0;
  const controller = new ReadinessController(
    observation,
    new ExistingReadinessPolicy({ frameStableObservations: 1, focusStableObservations: 1 }),
    new FreshReadinessPolicy({
      frameStableObservations: 1,
      focusStableObservations: 1,
      guardDurationMs: 0,
      clock: () => {
        freshClockCalls += 1;
        return freshClockCalls;
      },
    }),
    {
      timeoutMs: 100,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    },
  );

  await controller.waitForFreshRoute(oldLease);
  assert.equal(freshClockCalls, 1);

  runtime.observe({ pid: 200, creationTime: "runtime-b" });
  const newLease = runtime.getCurrentRuntimeLease();
  await controller.waitForTurnComposer({ kind: "FRESH_ROOT" }, newLease);
  assert.equal(freshClockCalls, 2);
});
