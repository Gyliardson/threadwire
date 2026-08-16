import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NodeCommandRunner,
  CommandExecutionError,
} from "../../src/runtime/CommandRunner.js";
import { OperationAbortedError } from "../../src/domain/errors.js";

test("NodeCommandRunner preserves CommandExecutionError properties diagnostically", async () => {
  const runner = new NodeCommandRunner();
  const script = `
    console.log('THREADWIRE_SYNTHETIC_STDOUT');
    console.error('THREADWIRE_SYNTHETIC_STDERR');
    process.exit(1);
  `;
  
  try {
    await runner.run(process.execPath, ["-e", script]);
    assert.fail("Runner should have thrown");
  } catch (err: unknown) {
    assert(err instanceof CommandExecutionError);
    assert(err.stdout.includes("THREADWIRE_SYNTHETIC_STDOUT"));
    assert(err.stderr.includes("THREADWIRE_SYNTHETIC_STDERR"));
    assert(err.cause instanceof Error);
    
    const descriptorStdout = Object.getOwnPropertyDescriptor(err, "stdout");
    assert.equal(descriptorStdout?.enumerable, false);
    
    const descriptorStderr = Object.getOwnPropertyDescriptor(err, "stderr");
    assert.equal(descriptorStderr?.enumerable, false);

    const keys = Object.keys(err);
    assert(!keys.includes("stdout"));
    assert(!keys.includes("stderr"));
    
    const jsonStr = JSON.stringify(err);
    assert(!jsonStr.includes("THREADWIRE_SYNTHETIC_STDOUT"));
    assert(!jsonStr.includes("THREADWIRE_SYNTHETIC_STDERR"));
  }
});

test("NodeCommandRunner preserves OperationAbortedError on abort", async () => {
  const runner = new NodeCommandRunner();
  const ac = new AbortController();
  
  const runPromise = runner.run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { signal: ac.signal });
  // Wait a tick to ensure the process actually spawned before aborting
  await new Promise((resolve) => setTimeout(resolve, 50));
  ac.abort();
  
  try {
    await runPromise;
    assert.fail("Runner should have thrown");
  } catch (err) {
    assert(err instanceof OperationAbortedError);
  }
});
