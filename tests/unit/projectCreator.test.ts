import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeGenerationTracker } from "../../src/domain/RuntimeGeneration.js";
import {
  ProjectCreationFailedError,
  ProjectNotFoundError,
  RuntimeGenerationChangedError,
  TurnStateUncertainError,
} from "../../src/domain/errors.js";
import { ProjectHandle, ProjectLocator, createProjectLocator } from "../../src/domain/ProjectIdentity.js";
import { ProjectCreator } from "../../src/project/ProjectCreator.js";
import { ProjectRegistry } from "../../src/project/ProjectRegistry.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";

function runtime(): RuntimeGenerationTracker {
  const tracker = new RuntimeGenerationTracker();
  tracker.observe({ pid: 1, creationTime: "runtime-a" });
  return tracker;
}

test("project creator schedules UI mutation and returns only an opaque handle", async () => {
  const tracker = runtime();
  const registry = new ProjectRegistry({ handleFactory: () => "project-test" });
  const creator = new ProjectCreator(
    registry,
    new OperationScheduler(tracker),
    {
      async createProjectThroughUi(name, lease) {
        assert.equal(name, "Threadwire Acceptance");
        tracker.assertRuntimeLeaseCurrent(lease);
        return createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000010/project");
      },
    },
  );

  const result = await creator.create("Threadwire Acceptance");
  assert.deepEqual(result, { projectHandle: "prj_project-test" });
  assert.equal(JSON.stringify(result).includes("g-p-00000000000000000000000000000010"), false);
});

test("project mutation waits behind TURN on the shared scheduler", async () => {
  const tracker = runtime();
  const scheduler = new OperationScheduler(tracker);
  const registry = new ProjectRegistry({ handleFactory: () => "serialized" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  const turn = scheduler.schedule("TURN", async () => {
    events.push("turn-start");
    await gate;
    events.push("turn-end");
  });
  const creator = new ProjectCreator(registry, scheduler, {
    async createProjectThroughUi() {
      events.push("project");
      return createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000011/project");
    },
  });
  const project = creator.create("Serialized Project");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["turn-start"]);
  release();
  await Promise.all([turn, project]);
  assert.deepEqual(events, ["turn-start", "turn-end", "project"]);
});

test("queued project rejects stale runtime before UI mutation", async () => {
  const tracker = runtime();
  const scheduler = new OperationScheduler(tracker);
  const registry = new ProjectRegistry();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const turn = scheduler.schedule("TURN", async () => await gate);
  let uiCalls = 0;
  const creator = new ProjectCreator(registry, scheduler, {
    async createProjectThroughUi() {
      uiCalls += 1;
      return createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000012/project");
    },
  });
  const project = creator.create("Stale Project");
  tracker.observe({ pid: 2, creationTime: "runtime-b" });
  release();
  await turn;
  await assert.rejects(project, RuntimeGenerationChangedError);
  assert.equal(uiCalls, 0);
});

test("project registry retries collisions and never enumerates locators", async () => {
  const values = ["same", "same", "different"];
  const registry = new ProjectRegistry({ handleFactory: () => values.shift() ?? "fallback" });
  const first = registry.register(createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000013/project"));
  const second = registry.register(createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000014/project"));
  assert.equal(first, "prj_same");
  assert.equal(second, "prj_different");
  assert.equal("knownProjects" in registry, false);
});

test("project registry returns a stable handle for a repeated validated locator", () => {
  let allocations = 0;
  const registry = new ProjectRegistry({
    handleFactory: () => `stable-${++allocations}`,
  });
  const locator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000015/project");

  assert.equal(registry.register(locator), "prj_stable-1");
  assert.equal(registry.register(locator), "prj_stable-1");
  assert.equal(allocations, 1);
  assert.throws(
    () => registry.register(
      "https://example.invalid/g/g-p-00000000000000000000000000000015/project" as ProjectLocator,
    ),
    /Project locator is invalid/,
  );
});

test("project registry resolves only known opaque handles without exposing other locators", () => {
  const registry = new ProjectRegistry({ handleFactory: () => "known-project" });
  const locator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000016/project");
  const handle = registry.register(locator);

  assert.equal(registry.resolve(handle), locator);
  assert.throws(
    () => registry.resolve("prj_unknown" as ProjectHandle),
    (error: unknown) =>
      error instanceof ProjectNotFoundError &&
      error.code === "PROJECT_NOT_FOUND" &&
      !error.message.includes("g-p-00000000000000000000000000000016"),
  );
});

test("invalid project timeout configuration fails before UI mutation", () => {
  let uiCalls = 0;
  assert.throws(
    () => new ProjectCreator(
      new ProjectRegistry(),
      new OperationScheduler(runtime()),
      {
        async createProjectThroughUi() {
          uiCalls += 1;
          return createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000017/project");
        },
      },
      { timeoutMs: Number.NaN },
    ),
    RangeError,
  );
  assert.equal(uiCalls, 0);
});

test("failure before project confirmation does not poison scheduler state", async () => {
  const tracker = runtime();
  const scheduler = new OperationScheduler(tracker);
  const creator = new ProjectCreator(new ProjectRegistry(), scheduler, {
    async createProjectThroughUi() {
      throw new Error("control unavailable");
    },
  });

  await assert.rejects(creator.create("Safe Failure"), ProjectCreationFailedError);
  assert.equal(await scheduler.schedule("TURN", async () => "still-safe"), "still-safe");
});

test("failure after project confirmation attempt poisons same-generation mutations", async () => {
  const tracker = runtime();
  const scheduler = new OperationScheduler(tracker);
  const creator = new ProjectCreator(new ProjectRegistry(), scheduler, {
    async createProjectThroughUi(_name, _lease, _signal, onMutationAttempted) {
      onMutationAttempted?.();
      throw new Error("post-confirmation failure");
    },
  });

  await assert.rejects(creator.create("Uncertain Failure"), ProjectCreationFailedError);
  await assert.rejects(
    scheduler.schedule("TURN", async () => "must-not-run"),
    TurnStateUncertainError,
  );
});
