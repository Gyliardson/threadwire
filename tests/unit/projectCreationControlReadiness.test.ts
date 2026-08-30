import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeGenerationTracker } from "../../src/domain/RuntimeGeneration.js";
import { OperationAbortedError, ProjectCreationFailedError } from "../../src/domain/errors.js";
import { createProjectLocator } from "../../src/domain/ProjectIdentity.js";
import { ProjectCreator } from "../../src/project/ProjectCreator.js";
import { ProjectRegistry } from "../../src/project/ProjectRegistry.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";

function runtime(): RuntimeGenerationTracker {
  const tracker = new RuntimeGenerationTracker();
  tracker.observe({ pid: 1, creationTime: "runtime-a" });
  return tracker;
}

test("project creator waits within its existing deadline when the creation control is initially unavailable", async () => {
  const tracker = runtime();
  let calls = 0;
  const creator = new ProjectCreator(
    new ProjectRegistry({ handleFactory: () => "delayed-control" }),
    new OperationScheduler(tracker),
    {
      async createProjectThroughUi(_name, lease) {
        tracker.assertRuntimeLeaseCurrent(lease);
        calls += 1;
        if (calls < 3) {
          throw new Error("Project creation control was unavailable.");
        }
        return createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000020/project");
      },
    },
    { timeoutMs: 1_000 },
  );

  assert.deepEqual(await creator.create("Delayed Control"), {
    projectHandle: "prj_delayed-control",
  });
  assert.equal(calls, 3);
});

test("project creator does not retry a different pre-confirmation UI failure", async () => {
  const tracker = runtime();
  let calls = 0;
  const creator = new ProjectCreator(
    new ProjectRegistry(),
    new OperationScheduler(tracker),
    {
      async createProjectThroughUi() {
        calls += 1;
        throw new Error("Project name input was unavailable.");
      },
    },
    { timeoutMs: 1_000 },
  );

  await assert.rejects(creator.create("No Blind Retry"), ProjectCreationFailedError);
  assert.equal(calls, 1);
});

test("project creation control readiness wait remains abortable and performs no later retry", async () => {
  const tracker = runtime();
  let calls = 0;
  const controller = new AbortController();
  const creator = new ProjectCreator(
    new ProjectRegistry(),
    new OperationScheduler(tracker),
    {
      async createProjectThroughUi() {
        calls += 1;
        controller.abort();
        throw new Error("Project creation control was unavailable.");
      },
    },
    { timeoutMs: 1_000 },
  );

  await assert.rejects(
    creator.create("Abort Readiness", controller.signal),
    OperationAbortedError,
  );
  assert.equal(calls, 1);
});
