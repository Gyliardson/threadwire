import test from "node:test";
import assert from "node:assert";
import { withTimeout, TimeoutError, delay } from "../../src/utils/timeout.js";

test("withTimeout resolves if promise completes in time", async () => {
  const p = Promise.resolve("success");
  const result = await withTimeout(p, 100);
  assert.strictEqual(result, "success");
});

test("withTimeout rejects if promise does not complete in time", async () => {
  const p = delay(200);
  await assert.rejects(
    () => withTimeout(p, 50, "Custom timeout message"),
    (err: any) => {
      assert.strictEqual(err instanceof TimeoutError, true);
      assert.strictEqual(err.message, "Custom timeout message");
      return true;
    }
  );
});
