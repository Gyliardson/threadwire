import assert from "node:assert/strict";
import test from "node:test";
import {
  ExistingReadinessGate,
  ExistingReadinessPolicy,
} from "../../src/readiness/ExistingReadinessPolicy.js";
import { ExistingReadinessSnapshot } from "../../src/readiness/types.js";

function snapshot(options: {
  expectedRoute?: boolean;
  frameId?: string;
  loaderId?: string;
  targets?: readonly Readonly<{ backendDOMNodeId: number; focused: boolean }>[];
  activeCount?: number;
  activityEpoch?: number;
} = {}): ExistingReadinessSnapshot {
  return {
    mainFrame: {
      frameId: options.frameId ?? "main-frame",
      loaderId: options.loaderId ?? "loader-a",
      expectedRoute: options.expectedRoute ?? true,
    },
    eligibleEditables: options.targets ?? [],
    backendActivity: {
      activeCount: options.activeCount ?? 0,
      activityEpoch: options.activityEpoch ?? 0,
    },
  };
}

function oneTarget(id = 101, focused = false): readonly Readonly<{
  backendDOMNodeId: number;
  focused: boolean;
}>[] {
  return [{ backendDOMNodeId: id, focused }];
}

function stableGate(): ExistingReadinessGate {
  return new ExistingReadinessPolicy().createGate();
}

test("expected route absent does not progress", () => {
  const gate = stableGate();
  assert.deepEqual(
    gate.observe(snapshot({ expectedRoute: false, targets: oneTarget(101, true) })),
    { kind: "WAIT" },
  );
});

test("stable expected route can progress to focus without a time threshold", () => {
  const gate = stableGate();
  assert.deepEqual(gate.observe(snapshot({ targets: oneTarget() })), { kind: "WAIT" });
  assert.deepEqual(gate.observe(snapshot({ targets: oneTarget() })), {
    kind: "FOCUS",
    backendDOMNodeId: 101,
  });
});

test("frame identity or loader changes reset frame stability", () => {
  const gate = stableGate();
  assert.deepEqual(gate.observe(snapshot({ targets: oneTarget() })), { kind: "WAIT" });
  assert.deepEqual(
    gate.observe(snapshot({ loaderId: "loader-b", targets: oneTarget() })),
    { kind: "WAIT" },
  );
  assert.deepEqual(
    gate.observe(snapshot({ loaderId: "loader-b", targets: oneTarget() })),
    { kind: "FOCUS", backendDOMNodeId: 101 },
  );

  const frameGate = stableGate();
  frameGate.observe(snapshot({ targets: oneTarget() }));
  assert.deepEqual(
    frameGate.observe(snapshot({ frameId: "replacement-frame", targets: oneTarget() })),
    { kind: "WAIT" },
  );
});

test("zero or multiple eligible editables fail closed", () => {
  const zero = stableGate();
  zero.observe(snapshot());
  assert.deepEqual(zero.observe(snapshot()), { kind: "WAIT" });

  const multiple = stableGate();
  multiple.observe(snapshot({ targets: oneTarget() }));
  assert.deepEqual(
    multiple.observe(
      snapshot({
        targets: [
          { backendDOMNodeId: 101, focused: false },
          { backendDOMNodeId: 202, focused: false },
        ],
      }),
    ),
    { kind: "WAIT" },
  );
});

test("focus command acceptance alone does not establish readiness", () => {
  const gate = stableGate();
  gate.observe(snapshot({ targets: oneTarget() }));
  assert.deepEqual(gate.observe(snapshot({ targets: oneTarget() })), {
    kind: "FOCUS",
    backendDOMNodeId: 101,
  });
  assert.deepEqual(gate.observe(snapshot({ targets: oneTarget(101, false) })), {
    kind: "FOCUS",
    backendDOMNodeId: 101,
  });
});

test("focus regression on the same eligible target reissues DOM.focus before readiness", () => {
  const gate = stableGate();
  gate.observe(snapshot({ targets: oneTarget() }));
  gate.observe(snapshot({ targets: oneTarget() }));
  gate.observe(snapshot({ targets: oneTarget(101, true) }));

  assert.deepEqual(gate.observe(snapshot({ targets: oneTarget(101, false) })), {
    kind: "FOCUS",
    backendDOMNodeId: 101,
  });
  assert.deepEqual(gate.observe(snapshot({ targets: oneTarget(101, true) })), {
    kind: "WAIT",
  });
  assert.deepEqual(gate.observe(snapshot({ targets: oneTarget(101, true) })), {
    kind: "READY",
  });
});

test("same intended target must be re-observed focused and stable", () => {
  const gate = stableGate();
  gate.observe(snapshot({ targets: oneTarget() }));
  gate.observe(snapshot({ targets: oneTarget() }));

  assert.deepEqual(gate.observe(snapshot({ targets: oneTarget(101, true) })), {
    kind: "WAIT",
  });
  assert.deepEqual(gate.observe(snapshot({ targets: oneTarget(101, true) })), {
    kind: "READY",
  });
});

test("focused target changing resets readiness and requires focus on the replacement", () => {
  const gate = stableGate();
  gate.observe(snapshot({ targets: oneTarget() }));
  gate.observe(snapshot({ targets: oneTarget() }));
  gate.observe(snapshot({ targets: oneTarget(101, true) }));

  assert.deepEqual(gate.observe(snapshot({ targets: oneTarget(202, true) })), {
    kind: "FOCUS",
    backendDOMNodeId: 202,
  });
  assert.deepEqual(gate.observe(snapshot({ targets: oneTarget(202, true) })), {
    kind: "WAIT",
  });
  assert.deepEqual(gate.observe(snapshot({ targets: oneTarget(202, true) })), {
    kind: "READY",
  });
});

test("active relevant backend activity blocks focus and readiness", () => {
  const gate = stableGate();
  gate.observe(snapshot({ targets: oneTarget(), activeCount: 1, activityEpoch: 1 }));
  assert.deepEqual(
    gate.observe(snapshot({ targets: oneTarget(), activeCount: 1, activityEpoch: 1 })),
    { kind: "WAIT" },
  );
  assert.deepEqual(
    gate.observe(snapshot({ targets: oneTarget(), activeCount: 0, activityEpoch: 2 })),
    { kind: "FOCUS", backendDOMNodeId: 101 },
  );
});

test("backend activity epoch changes reset final focused stability", () => {
  const gate = stableGate();
  gate.observe(snapshot({ targets: oneTarget(), activityEpoch: 2 }));
  gate.observe(snapshot({ targets: oneTarget(), activityEpoch: 2 }));
  gate.observe(snapshot({ targets: oneTarget(101, true), activityEpoch: 2 }));

  assert.deepEqual(
    gate.observe(snapshot({ targets: oneTarget(101, true), activityEpoch: 4 })),
    { kind: "WAIT" },
  );
  assert.deepEqual(
    gate.observe(snapshot({ targets: oneTarget(101, true), activityEpoch: 4 })),
    { kind: "READY" },
  );
});

test("policy uses observation counts rather than historical multi-second timing", () => {
  const gate = new ExistingReadinessPolicy({
    frameStableObservations: 1,
    focusStableObservations: 1,
  }).createGate();

  assert.deepEqual(gate.observe(snapshot({ targets: oneTarget() })), {
    kind: "FOCUS",
    backendDOMNodeId: 101,
  });
  assert.deepEqual(gate.observe(snapshot({ targets: oneTarget(101, true) })), {
    kind: "READY",
  });
});
