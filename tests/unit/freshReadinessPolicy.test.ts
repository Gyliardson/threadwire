import assert from "node:assert/strict";
import test from "node:test";
import { FreshReadinessPolicy, DEFAULT_FRESH_GUARD_DURATION_MS } from "../../src/readiness/FreshReadinessPolicy.js";
import { ExistingReadinessSnapshot } from "../../src/readiness/types.js";

function createSnapshot(
  expectedRoute: boolean,
  eligibleEditablesCount: number,
  focused: boolean,
  activityEpoch: number,
  frameId: string = "frame-1",
  loaderId: string = "loader-1",
  backendDOMNodeId: number = 42,
): ExistingReadinessSnapshot {
  return {
    mainFrame: { frameId, loaderId, expectedRoute },
    eligibleEditables: Array.from({ length: eligibleEditablesCount }).map((_, i) => ({
      backendDOMNodeId: backendDOMNodeId + i,
      focused,
    })),
    backendActivity: { activeCount: 0, activityEpoch },
  };
}

function stabilizeInnerGate(gate: ReturnType<FreshReadinessPolicy["createGate"]>, snapshot: ExistingReadinessSnapshot) {
  // Uses default 2/2 stable counts
  assert.deepEqual(gate.observe(snapshot), { kind: "WAIT" }); // frame=1
  assert.deepEqual(gate.observe(snapshot), { kind: "FOCUS", backendDOMNodeId: 42 }); // frame=2, focus target set
  assert.deepEqual(gate.observe(snapshot), { kind: "WAIT" }); // focusStable=1
  assert.deepEqual(gate.observe(snapshot), { kind: "WAIT" }); // focusStable=2, inner=READY, outer starts guard
}

test("does not resolve before the guard duration", () => {
  let time = 1000;
  const policy = new FreshReadinessPolicy({ clock: () => time });
  const gate = policy.createGate();
  const snapshot = createSnapshot(true, 1, true, 1);

  stabilizeInnerGate(gate, snapshot);

  // Guard active
  time += DEFAULT_FRESH_GUARD_DURATION_MS - 1;
  assert.deepEqual(gate.observe(snapshot), { kind: "WAIT" });

  // Guard reached
  time += 1;
  assert.deepEqual(gate.observe(snapshot), { kind: "READY" });
});

test("requires final observation to be ready after guard", () => {
  let time = 1000;
  const policy = new FreshReadinessPolicy({ clock: () => time });
  const gate = policy.createGate();
  const snapshot = createSnapshot(true, 1, true, 1);

  stabilizeInnerGate(gate, snapshot);

  time += DEFAULT_FRESH_GUARD_DURATION_MS;
  const lostFocusSnapshot = createSnapshot(true, 1, false, 1);
  // Focus lost -> returns FOCUS
  assert.deepEqual(gate.observe(lostFocusSnapshot), { kind: "FOCUS", backendDOMNodeId: 42 });

  time += 100;
  // Regain focus -> takes 2 snapshots to stabilize again
  assert.deepEqual(gate.observe(snapshot), { kind: "WAIT" }); // focus=1
  assert.deepEqual(gate.observe(snapshot), { kind: "WAIT" }); // focus=2, starts guard

  time += DEFAULT_FRESH_GUARD_DURATION_MS;
  assert.deepEqual(gate.observe(snapshot), { kind: "READY" });
});

test("resets the entire window if activityEpoch changes during guard", () => {
  let time = 1000;
  const policy = new FreshReadinessPolicy({ clock: () => time });
  const gate = policy.createGate();
  const snapshot = createSnapshot(true, 1, true, 1);

  stabilizeInnerGate(gate, snapshot);

  time += 250;
  assert.deepEqual(gate.observe(snapshot), { kind: "WAIT" });

  const epochChangedSnapshot = createSnapshot(true, 1, true, 2);
  time += 100;
  // Epoch changes -> focusStable=1 -> returns WAIT from inner gate, outer resets guardStartMs
  assert.deepEqual(gate.observe(epochChangedSnapshot), { kind: "WAIT" });
  // focusStable=2 -> inner READY -> outer starts guard
  assert.deepEqual(gate.observe(epochChangedSnapshot), { kind: "WAIT" });

  time += 150; // Total 500ms since original start
  assert.deepEqual(gate.observe(epochChangedSnapshot), { kind: "WAIT" });

  time += 350; // Total 500ms since epoch change stabilization
  assert.deepEqual(gate.observe(epochChangedSnapshot), { kind: "READY" });
});

test("resets if frame changes during guard", () => {
  let time = 1000;
  const policy = new FreshReadinessPolicy({ clock: () => time });
  const gate = policy.createGate();
  const snapshot = createSnapshot(true, 1, true, 1);

  stabilizeInnerGate(gate, snapshot);

  time += 499;
  const frameChangedSnapshot = createSnapshot(true, 1, true, 1, "frame-2");
  // Frame reset -> frameStable=1 -> WAIT
  assert.deepEqual(gate.observe(frameChangedSnapshot), { kind: "WAIT" });
  // frameStable=2 -> FOCUS target reset -> FOCUS
  assert.deepEqual(gate.observe(frameChangedSnapshot), { kind: "FOCUS", backendDOMNodeId: 42 });
  // focusStable=1 -> WAIT
  assert.deepEqual(gate.observe(frameChangedSnapshot), { kind: "WAIT" });
  // focusStable=2 -> READY, start guard -> WAIT
  assert.deepEqual(gate.observe(frameChangedSnapshot), { kind: "WAIT" });

  time += DEFAULT_FRESH_GUARD_DURATION_MS;
  assert.deepEqual(gate.observe(frameChangedSnapshot), { kind: "READY" });
});
