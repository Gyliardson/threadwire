import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("M8 production composition shares exactly one scheduler across routing and turns", async () => {
  const source = await readFile(
    new URL("../../src/controller/ThreadwireController.ts", import.meta.url),
    "utf8",
  );

  assert.equal((source.match(/new OperationScheduler\(/g) ?? []).length, 1);
  assert.match(source, /new ConversationRouter\(registry, scheduler, cdp, readiness\)/);
  assert.match(source, /new TurnExecutor\(registry, scheduler, readiness, cdp\)/);
});

test("M8 controller does not implicitly restart a running Classic runtime", async () => {
  const source = await readFile(
    new URL("../../src/controller/ThreadwireController.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /\.restart\(/);
  assert.match(source, /runtime\.ensureStarted\(signal\)/);
});
