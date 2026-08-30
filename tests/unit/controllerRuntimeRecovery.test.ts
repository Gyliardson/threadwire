import assert from "node:assert/strict";
import test from "node:test";
import { ControllerBusyError } from "../../src/controller/ControllerTurnQueue.js";
import {
  ThreadwireController,
  ThreadwireControllerDependencies,
} from "../../src/controller/ThreadwireController.js";
import { TurnStateUncertainError } from "../../src/domain/errors.js";
import { createProjectLocator } from "../../src/domain/ProjectIdentity.js";
import { ThreadHandle } from "../../src/domain/ThreadIdentity.js";
import { serializePublicError } from "../../src/api/PublicError.js";
import { TurnResult } from "../../src/turn/types.js";

const THREAD_HANDLE = "tw_recovery_fixture" as ThreadHandle;
const PROJECT_LOCATOR = createProjectLocator(
  "https://chatgpt.com/g/g-p-00000000000000000000000000000088/project",
);

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function existingResult(): TurnResult {
  return Object.freeze({ kind: "THREAD" as const, threadHandle: THREAD_HANDLE, created: false as const });
}

function createdResult(): TurnResult {
  return Object.freeze({ kind: "THREAD" as const, threadHandle: THREAD_HANDLE, created: true as const });
}

function fixture(options: {
  execute?: () => Promise<TurnResult>;
} = {}): {
  controller: ThreadwireController;
  calls: string[];
} {
  const calls: string[] = [];
  const dependencies: ThreadwireControllerDependencies = {
    runtime: {
      inspect: async () => ({ isRunning: true }),
      ensureStarted: async () => {
        calls.push("runtime.ensureStarted");
      },
      restart: async () => {
        calls.push("runtime.restart");
      },
    },
    cdp: {
      state: "CONNECTED",
      connect: async () => {
        calls.push("cdp.connect");
      },
      disconnect: async () => {
        calls.push("cdp.disconnect");
      },
      assertCurrentRuntime: () => {
        calls.push("cdp.assertCurrentRuntime");
      },
    },
    registry: {
      resolve: () => ({}),
      registrationState: () => "COMMITTED",
      waitForCommit: async () => undefined,
      knownThreads: () => [THREAD_HANDLE],
    },
    projectRegistry: {
      resolve: () => PROJECT_LOCATOR,
    },
    router: {
      routeFresh: async () => {
        calls.push("router.routeFresh");
      },
      routeToThread: async () => {
        calls.push("router.routeToThread");
      },
      routeToProject: async () => {
        calls.push("router.routeToProject");
      },
    },
    executor: {
      executeStreaming: async () => {
        calls.push("executor.executeStreaming");
        return await (options.execute?.() ?? Promise.resolve(existingResult()));
      },
    },
    projectCreator: {
      create: async () => {
        throw new Error("project creation is outside this fixture");
      },
    },
  };
  return { controller: new ThreadwireController(dependencies), calls };
}

test("runtime recovery is serialized behind an active conversational turn", async () => {
  const turn = deferred<TurnResult>();
  const { controller, calls } = fixture({ execute: async () => await turn.promise });

  const activeTurn = controller.executeTurn(
    { target: { kind: "FRESH" }, prompt: "fixture" },
    () => undefined,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const recovery = controller.recoverRuntime();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.includes("cdp.disconnect"), false);
  assert.equal(calls.includes("runtime.restart"), false);

  turn.resolve(existingResult());
  await activeTurn;
  const health = await recovery;

  assert.deepEqual(health, { classic: "RUNNING", cdp: "CONNECTED" });
  assert.deepEqual(calls.slice(-4), [
    "cdp.disconnect",
    "runtime.restart",
    "cdp.connect",
    "cdp.assertCurrentRuntime",
  ]);
});

test("runtime recovery waits for Project public-completion confirmation", async () => {
  const { controller, calls } = fixture({ execute: async () => createdResult() });
  const result = await controller.executeTurn(
    { target: { kind: "PROJECT", projectHandle: "prj_recovery_fixture" as never }, prompt: "fixture" },
    () => undefined,
  );

  const recovery = controller.recoverRuntime();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.includes("cdp.disconnect"), false);

  controller.confirmTurnCompletion(result);
  await recovery;
  assert.equal(calls.includes("runtime.restart"), true);
});

test("rolled-back Project completion permits explicit recovery without replaying the uncertain turn", async () => {
  const { controller, calls } = fixture({ execute: async () => createdResult() });
  const result = await controller.executeTurn(
    { target: { kind: "PROJECT", projectHandle: "prj_recovery_fixture" as never }, prompt: "fixture" },
    () => undefined,
  );

  assert.equal(calls.filter((call) => call === "executor.executeStreaming").length, 1);
  controller.rollbackTurnCompletion(result);

  const health = await controller.recoverRuntime();

  assert.deepEqual(health, { classic: "RUNNING", cdp: "CONNECTED" });
  assert.equal(calls.filter((call) => call === "executor.executeStreaming").length, 1);
  assert.deepEqual(calls.slice(-4), [
    "cdp.disconnect",
    "runtime.restart",
    "cdp.connect",
    "cdp.assertCurrentRuntime",
  ]);
});

test("public retry classification is true only for proven pre-admission controller capacity", () => {
  assert.deepEqual(serializePublicError(new ControllerBusyError()), {
    error: {
      code: "CONTROLLER_BUSY",
      message: "Threadwire controller capacity is full.",
      retryable: true,
    },
  });
  assert.equal(serializePublicError(new TurnStateUncertainError()).error.retryable, false);
  assert.equal(serializePublicError(new Error("internal canary")).error.retryable, false);
});
