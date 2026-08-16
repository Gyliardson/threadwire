import assert from "node:assert/strict";
import test from "node:test";
import {
  RuntimeGenerationTracker,
  runtimeGenerationNumber,
} from "../../src/domain/RuntimeGeneration.js";
import { RuntimeGenerationChangedError, RuntimeNotObservedError } from "../../src/domain/errors.js";

const runtimeA = { pid: 100, creationTime: "2026-08-16T12:00:00Z" };
const runtimeB = { pid: 200, creationTime: "2026-08-16T12:01:00Z" };

test("runtime generation advances only when the observed Main identity changes", () => {
  const tracker = new RuntimeGenerationTracker();
  assert.equal(runtimeGenerationNumber(tracker.currentGeneration), 0);
  assert.throws(() => tracker.getCurrentRuntimeLease(), RuntimeNotObservedError);

  assert.equal(runtimeGenerationNumber(tracker.observe(runtimeA)), 1);
  assert.equal(runtimeGenerationNumber(tracker.observe(runtimeA)), 1);
  tracker.observe(null);
  assert.equal(runtimeGenerationNumber(tracker.currentGeneration), 1);
  assert.equal(runtimeGenerationNumber(tracker.observe(runtimeB)), 2);
});

test("runtime leases reject stale work after Main replacement", () => {
  const tracker = new RuntimeGenerationTracker();
  tracker.observe(runtimeA);
  const leaseA = tracker.getCurrentRuntimeLease();
  tracker.assertRuntimeLeaseCurrent(leaseA);

  tracker.observe(runtimeB);
  assert.throws(() => tracker.assertRuntimeLeaseCurrent(leaseA), RuntimeGenerationChangedError);
  const leaseB = tracker.getCurrentRuntimeLease();
  tracker.assertRuntimeLeaseCurrent(leaseB);
});
