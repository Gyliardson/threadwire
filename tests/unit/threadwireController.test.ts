import assert from "node:assert/strict";
import test from "node:test";
import { CdpConnectionState } from "../../src/domain/RuntimeState.js";
import { ThreadHandle } from "../../src/domain/ThreadIdentity.js";
import { ProjectHandle } from "../../src/domain/ProjectIdentity.js";
import { OperationAbortedError, ThreadNotFoundError } from "../../src/domain/errors.js";
import {
  ControllerTurnRequest,
  ThreadwireController,
  ThreadwireControllerDependencies,
} from "../../src/controller/ThreadwireController.js";
import { ControllerBusyError } from "../../src/controller/ControllerTurnQueue.js";
import { TurnResult } from "../../src/turn/types.js";

const HANDLE = "tw_test_handle" as ThreadHandle;
const PROJECT_HANDLE = "prj_test_handle" as ProjectHandle;
const FRESH_REQUEST: ControllerTurnRequest = {
  target: { kind: "FRESH" },
  prompt: "hello",
};

function result(created = true): TurnResult {
  if (created) {
    return Object.freeze({ kind: "THREAD" as const, threadHandle: HANDLE, created: true as const });
  }
  return Object.freeze({ kind: "THREAD" as const, threadHandle: HANDLE, created: false as const });
}

function dependencies(overrides: Partial<ThreadwireControllerDependencies> = {}) {
  const calls: string[] = [];
  let cdpState: CdpConnectionState = "DISCONNECTED";

  const base: ThreadwireControllerDependencies = {
    runtime: {
      async inspect() {
        calls.push("inspect");
        return { isRunning: true };
      },
      async ensureStarted() {
        calls.push("ensureStarted");
      },
    },
    cdp: {
      get state() {
        return cdpState;
      },
      async connect() {
        calls.push("connect");
        cdpState = "CONNECTED";
      },
      async disconnect() {
        calls.push("disconnect");
        cdpState = "DISCONNECTED";
      },
      assertCurrentRuntime() {
        calls.push("assertCurrentRuntime");
      },
    },
    registry: {
      resolve(handle) {
        calls.push(`resolve:${handle}`);
        if (handle !== HANDLE) {
          throw new ThreadNotFoundError();
        }
        return "private-locator";
      },
      knownThreads() {
        return [HANDLE];
      },
    },
    router: {
      async routeFresh() {
        calls.push("routeFresh");
      },
      async routeToThread(handle) {
        calls.push(`routeThread:${handle}`);
      },
    },
    executor: {
      async executeStreaming(target, text, listener) {
        calls.push(`execute:${target.kind}:${text}`);
        listener({ type: "FINAL_TEXT", text: "answer" });
        listener({ type: "COMPLETED" });
        return result(target.kind === "FRESH");
      },
    },
    projectCreator: {
      async create(name) {
        calls.push(`createProject:${name}`);
        return { projectHandle: PROJECT_HANDLE };
      },
    },
  };

  return {
    calls,
    dependencies: { ...base, ...overrides } satisfies ThreadwireControllerDependencies,
  };
}

test("health is read-only and exposes no process identity", async () => {
  const fixture = dependencies();
  const controller = new ThreadwireController(fixture.dependencies);

  assert.deepEqual(await controller.health(), { classic: "RUNNING", cdp: "DISCONNECTED" });
  assert.deepEqual(fixture.calls, ["inspect"]);
});

test("unknown handles fail before runtime startup or routing", () => {
  const fixture = dependencies();
  const controller = new ThreadwireController(fixture.dependencies);
  const unknown = "tw_unknown" as ThreadHandle;

  assert.throws(
    () =>
      controller.executeTurn(
        { target: { kind: "THREAD", threadHandle: unknown }, prompt: "x" },
        () => undefined,
      ),
    ThreadNotFoundError,
  );
  assert.deepEqual(fixture.calls, [`resolve:${unknown}`]);
});

test("fresh workflow establishes runtime then routes then executes", async () => {
  const fixture = dependencies();
  const controller = new ThreadwireController(fixture.dependencies);
  const eventTypes: string[] = [];

  const turn = await controller.executeTurn(FRESH_REQUEST, (event) => eventTypes.push(event.type));

  assert.equal(turn.created, true);
  assert.deepEqual(eventTypes, ["FINAL_TEXT", "COMPLETED"]);
  assert.deepEqual(fixture.calls, [
    "ensureStarted",
    "connect",
    "assertCurrentRuntime",
    "routeFresh",
    "execute:FRESH:hello",
  ]);
});

test("existing workflow validates the handle then routes the same opaque handle", async () => {
  const fixture = dependencies();
  const controller = new ThreadwireController(fixture.dependencies);

  const turn = await controller.executeTurn(
    { target: { kind: "THREAD", threadHandle: HANDLE }, prompt: "follow-up" },
    () => undefined,
  );

  assert.equal(turn.created, false);
  assert.deepEqual(fixture.calls, [
    `resolve:${HANDLE}`,
    "ensureStarted",
    "connect",
    "assertCurrentRuntime",
    `routeThread:${HANDLE}`,
    "execute:THREAD:follow-up",
  ]);
});

test("project workflow establishes runtime and returns an opaque handle", async () => {
  const fixture = dependencies();
  const controller = new ThreadwireController(fixture.dependencies);
  const created = await controller.createProject({ name: "Threadwire Acceptance" });
  assert.deepEqual(created, { projectHandle: PROJECT_HANDLE });
  assert.deepEqual(fixture.calls, [
    "ensureStarted",
    "connect",
    "assertCurrentRuntime",
    "createProject:Threadwire Acceptance",
  ]);
});

test("controller queue prevents project creation from interleaving with a turn workflow", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fixture = dependencies({
    executor: {
      async executeStreaming() {
        await gate;
        return result(true);
      },
    },
  });
  const controller = new ThreadwireController(fixture.dependencies, { maxOutstandingTurns: 2 });
  const turn = controller.executeTurn(FRESH_REQUEST, () => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const project = controller.createProject({ name: "Serialized Project" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls.includes("createProject:Serialized Project"), false);
  release();
  await Promise.all([turn, project]);
  assert.equal(fixture.calls.includes("createProject:Serialized Project"), true);
});

test("controller queue continues after a started project workflow rejects", async () => {
  const fixture = dependencies({
    projectCreator: {
      async create() {
        throw new Error("synthetic project failure");
      },
    },
  });
  const controller = new ThreadwireController(fixture.dependencies, { maxOutstandingTurns: 2 });
  const project = controller.createProject({ name: "Rejected Project" });
  const turn = controller.executeTurn(FRESH_REQUEST, () => undefined);

  await assert.rejects(project, /synthetic project failure/);
  assert.equal((await turn).created, true);
  assert.equal(fixture.calls.includes("execute:FRESH:hello"), true);
});

test("the controller queue serializes the complete route-to-turn workflow", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let executionCount = 0;
  const fixture = dependencies({
    executor: {
      async executeStreaming() {
        executionCount += 1;
        if (executionCount === 1) {
          await firstGate;
        }
        return result(true);
      },
    },
  });
  const controller = new ThreadwireController(fixture.dependencies, { maxOutstandingTurns: 2 });

  const first = controller.executeTurn(FRESH_REQUEST, () => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = controller.executeTurn(FRESH_REQUEST, () => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(fixture.calls.filter((call) => call === "ensureStarted").length, 1);
  assert.equal(fixture.calls.filter((call) => call === "routeFresh").length, 1);

  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(fixture.calls.filter((call) => call === "ensureStarted").length, 2);
  assert.equal(fixture.calls.filter((call) => call === "routeFresh").length, 2);
});

test("capacity is rejected synchronously before additional work is admitted", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = dependencies({
    executor: {
      async executeStreaming() {
        await gate;
        return result(true);
      },
    },
  });
  const controller = new ThreadwireController(fixture.dependencies, { maxOutstandingTurns: 1 });

  const first = controller.executeTurn(FRESH_REQUEST, () => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.throws(
    () => controller.executeTurn(FRESH_REQUEST, () => undefined),
    ControllerBusyError,
  );

  release();
  await first;
});

test("an aborted queued workflow never starts", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let executions = 0;
  const fixture = dependencies({
    executor: {
      async executeStreaming() {
        executions += 1;
        if (executions === 1) {
          await gate;
        }
        return result(true);
      },
    },
  });
  const controller = new ThreadwireController(fixture.dependencies, { maxOutstandingTurns: 2 });
  const first = controller.executeTurn(FRESH_REQUEST, () => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const abortController = new AbortController();
  const second = controller.executeTurn(FRESH_REQUEST, () => undefined, abortController.signal);
  abortController.abort({ secret: "must-not-be-retained-by-controller-queue" });

  await assert.rejects(second, OperationAbortedError);
  assert.equal(executions, 1);
  release();
  await first;
  assert.equal(executions, 1);
});
