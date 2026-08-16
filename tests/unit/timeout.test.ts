import assert from "node:assert/strict";
import test from "node:test";
import { OperationAbortedError, OperationTimeoutError } from "../../src/domain/errors.js";
import { delay, withTimeout } from "../../src/utils/timeout.js";

test("withTimeout resolves when the operation finishes before its deadline", async () => {
  const result = await withTimeout(async () => "success", 100);
  assert.equal(result, "success");
});

test("withTimeout aborts the operation signal when the deadline expires", async () => {
  let observedAbort = false;
  await assert.rejects(
    () =>
      withTimeout(async (signal) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
        });
        await delay(200, signal);
      }, 20),
    OperationTimeoutError,
  );
  assert.equal(observedAbort, true);
});

test("withTimeout propagates parent cancellation as a stable Threadwire error", async () => {
  const controller = new AbortController();
  const promise = withTimeout(async (signal) => await delay(200, signal), 1000, {
    signal: controller.signal,
  });
  controller.abort(new Error("synthetic parent reason"));
  await assert.rejects(promise, OperationAbortedError);
});

test("delay is AbortSignal-aware", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => delay(1, controller.signal), OperationAbortedError);
});
