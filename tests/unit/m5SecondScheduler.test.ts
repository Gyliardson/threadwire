import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeGenerationTracker } from "../../src/domain/RuntimeGeneration.js";
import { TurnStateUncertainError } from "../../src/domain/errors.js";
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

test("ROUTE queued while safe is rejected at callback start if active TURN later marks lease uncertain", async () => {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 700, creationTime: "scheduler-a" });
  const scheduler = new OperationScheduler(runtime);
  const turnStarted = deferred<void>();
  const releaseTurn = deferred<void>();
  const markUncertain = deferred<void>();

  const activeTurn = scheduler.schedule("TURN", async (_signal, lease) => {
    turnStarted.resolve();
    await markUncertain.promise;
    scheduler.markRuntimeMutationStateUncertain(lease);
    await releaseTurn.promise;
  });
  await turnStarted.promise;

  let routeCallbackCount = 0;
  const queuedRoute = scheduler.schedule("ROUTE", async () => {
    routeCallbackCount += 1;
  });
  await Promise.resolve();
  assert.equal(routeCallbackCount, 0, "ROUTE is queued while lease is still safe");

  markUncertain.resolve();
  await Promise.resolve();
  releaseTurn.resolve();
  await activeTurn;

  await assert.rejects(queuedRoute, TurnStateUncertainError);
  assert.equal(routeCallbackCount, 0, "callback-time uncertainty check must prevent mutation");
});
