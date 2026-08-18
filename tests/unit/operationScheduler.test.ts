import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeGenerationTracker } from "../../src/domain/RuntimeGeneration.js";
import {
  OperationAbortedError,
  RuntimeGenerationChangedError,
  TurnStateUncertainError,
} from "../../src/domain/errors.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function createRuntime(): RuntimeGenerationTracker {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 100, creationTime: "runtime-a" });
  return runtime;
}

test("scheduler executes FIFO with at most one mutating callback active", async () => {
  const scheduler = new OperationScheduler(createRuntime());
  const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
  const started: number[] = [];
  let active = 0;
  let maxActive = 0;

  const promises = gates.map((gate, index) =>
    scheduler.schedule("ROUTE", async () => {
      started.push(index);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate.promise;
      active -= 1;
      return index;
    }),
  );

  await Promise.resolve();
  assert.deepEqual(started, [0]);
  gates[0]!.resolve();
  await promises[0];
  await Promise.resolve();
  assert.deepEqual(started, [0, 1]);
  gates[1]!.resolve();
  await promises[1];
  await Promise.resolve();
  assert.deepEqual(started, [0, 1, 2]);
  gates[2]!.resolve();

  assert.deepEqual(await Promise.all(promises), [0, 1, 2]);
  assert.equal(maxActive, 1);
});

test("a failed operation does not poison subsequent queued work", async () => {
  const scheduler = new OperationScheduler(createRuntime());
  const first = scheduler.schedule("ROUTE", async () => {
    throw new Error("synthetic failure");
  });
  const second = scheduler.schedule("ROUTE", async () => "second-ran");

  await assert.rejects(first, /synthetic failure/);
  assert.equal(await second, "second-ran");
});

test("queued abort rejects with OperationAbortedError and never invokes the callback", async () => {
  const scheduler = new OperationScheduler(createRuntime());
  const turnGate = deferred<void>();
  const turn = scheduler.schedule("TURN", async () => await turnGate.promise);
  const controller = new AbortController();
  let routeRan = false;
  const route = scheduler.schedule(
    "ROUTE",
    async () => {
      routeRan = true;
    },
    { signal: controller.signal },
  );

  controller.abort(new Error("synthetic cancel"));
  await assert.rejects(route, OperationAbortedError);
  assert.equal(routeRan, false);
  turnGate.resolve();
  await turn;
  await Promise.resolve();
  assert.equal(routeRan, false);
});

test("active TURN blocks ROUTE until the turn completes when the runtime remains current", async () => {
  const scheduler = new OperationScheduler(createRuntime());
  const turnGate = deferred<void>();
  const events: string[] = [];
  const turn = scheduler.schedule("TURN", async () => {
    events.push("turn-start");
    await turnGate.promise;
    events.push("turn-end");
  });
  const route = scheduler.schedule("ROUTE", async () => {
    events.push("route");
  });

  await Promise.resolve();
  assert.deepEqual(events, ["turn-start"]);
  turnGate.resolve();
  await Promise.all([turn, route]);
  assert.deepEqual(events, ["turn-start", "turn-end", "route"]);
});

test("runtime replacement while queued rejects stale work before callback invocation", async () => {
  const runtime = createRuntime();
  const scheduler = new OperationScheduler(runtime);
  const turnGate = deferred<void>();
  const turn = scheduler.schedule("TURN", async () => await turnGate.promise);
  let routeRan = false;
  const route = scheduler.schedule("ROUTE", async () => {
    routeRan = true;
  });

  runtime.observe({ pid: 200, creationTime: "runtime-b" });
  turnGate.resolve();
  await turn;
  await assert.rejects(route, RuntimeGenerationChangedError);
  assert.equal(routeRan, false);
});

test("uncertain same-generation turn state blocks queued ROUTE and newly scheduled mutations", async () => {
  const runtime = createRuntime();
  const scheduler = new OperationScheduler(runtime);
  const activeGate = deferred<void>();
  const active = scheduler.schedule("TURN", async (_signal, lease) => {
    scheduler.markRuntimeMutationStateUncertain(lease);
    await activeGate.promise;
  });

  let queuedRouteRan = false;
  const queuedRoute = scheduler.schedule("ROUTE", async () => {
    queuedRouteRan = true;
  });
  await Promise.resolve();
  activeGate.resolve();
  await active;
  await assert.rejects(queuedRoute, TurnStateUncertainError);
  assert.equal(queuedRouteRan, false);

  let newTurnRan = false;
  await assert.rejects(
    () => scheduler.schedule("TURN", async () => {
      newTurnRan = true;
    }),
    TurnStateUncertainError,
  );
  assert.equal(newTurnRan, false);
});

test("runtime replacement clears the old uncertain latch for the replacement generation", async () => {
  const runtime = createRuntime();
  const scheduler = new OperationScheduler(runtime);
  scheduler.markRuntimeMutationStateUncertain(runtime.getCurrentRuntimeLease());

  await assert.rejects(
    () => scheduler.schedule("ROUTE", async () => undefined),
    TurnStateUncertainError,
  );

  runtime.observe({ pid: 200, creationTime: "runtime-b" });
  let ran = false;
  await scheduler.schedule("TURN", async () => {
    ran = true;
  });
  assert.equal(ran, true);
});
