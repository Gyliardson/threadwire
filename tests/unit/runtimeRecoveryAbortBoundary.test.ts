import assert from "node:assert/strict";
import test from "node:test";
import { ThreadwireController, ThreadwireControllerDependencies } from "../../src/controller/ThreadwireController.js";
import { createProjectLocator } from "../../src/domain/ProjectIdentity.js";
import { ThreadHandle } from "../../src/domain/ThreadIdentity.js";
import { TurnResult } from "../../src/turn/types.js";

const THREAD_HANDLE = "tw_recovery_abort_fixture" as ThreadHandle;
const PROJECT_LOCATOR = createProjectLocator(
  "https://chatgpt.com/g/g-p-00000000000000000000000000000089/project",
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

test("client abort after destructive recovery starts keeps mutation serialization until lifecycle quiescence", async () => {
  const calls: string[] = [];
  const restartStarted = deferred<void>();
  const lifecycleQuiesced = deferred<void>();

  const dependencies: ThreadwireControllerDependencies = {
    runtime: {
      inspect: async () => ({ isRunning: true }),
      ensureStarted: async () => {
        calls.push("runtime.ensureStarted");
      },
      restart: async (signal?: AbortSignal) => {
        assert.equal(signal, undefined, "destructive restart must detach from the client abort signal");
        calls.push("runtime.restart");
        restartStarted.resolve(undefined);
        await lifecycleQuiesced.promise;
      },
    },
    cdp: {
      state: "CONNECTED",
      connect: async (signal?: AbortSignal) => {
        assert.equal(signal, undefined, "post-restart reconnect must detach from the client abort signal");
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
        return existingResult();
      },
    },
    projectCreator: {
      create: async () => {
        throw new Error("project creation is outside this fixture");
      },
    },
  };

  const controller = new ThreadwireController(dependencies);
  const abort = new AbortController();
  const recovery = controller.recoverRuntime(abort.signal);
  await restartStarted.promise;

  assert.deepEqual(calls.slice(0, 2), ["cdp.disconnect", "runtime.restart"]);
  abort.abort();

  let recoverySettled = false;
  void recovery.finally(() => {
    recoverySettled = true;
  });

  const nextTurn = controller.executeTurn(
    { target: { kind: "FRESH" }, prompt: "fixture" },
    () => undefined,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(recoverySettled, false, "recovery must remain active until the lifecycle reaches quiescence");
  assert.equal(
    calls.includes("runtime.ensureStarted"),
    false,
    "next mutation entered while the destructive restart lifecycle was still not quiescent",
  );

  lifecycleQuiesced.resolve(undefined);
  await recovery;
  await nextTurn;

  assert.deepEqual(calls.slice(0, 4), [
    "cdp.disconnect",
    "runtime.restart",
    "cdp.connect",
    "cdp.assertCurrentRuntime",
  ]);
  assert.equal(calls.includes("executor.executeStreaming"), true);
});

test("client abort before recovery admission remains cancellable without destructive lifecycle", async () => {
  const calls: string[] = [];
  const activeTurnStarted = deferred<void>();
  const releaseTurn = deferred<void>();

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
      assertCurrentRuntime: () => undefined,
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
      routeFresh: async () => undefined,
      routeToThread: async () => undefined,
      routeToProject: async () => undefined,
    },
    executor: {
      executeStreaming: async () => {
        activeTurnStarted.resolve(undefined);
        await releaseTurn.promise;
        return existingResult();
      },
    },
    projectCreator: {
      create: async () => {
        throw new Error("project creation is outside this fixture");
      },
    },
  };

  const controller = new ThreadwireController(dependencies);
  const turn = controller.executeTurn(
    { target: { kind: "FRESH" }, prompt: "fixture" },
    () => undefined,
  );
  await activeTurnStarted.promise;

  const abort = new AbortController();
  const recovery = controller.recoverRuntime(abort.signal);
  abort.abort();
  await assert.rejects(recovery, { name: "OperationAbortedError" });

  assert.equal(calls.includes("cdp.disconnect"), false);
  assert.equal(calls.includes("runtime.restart"), false);

  releaseTurn.resolve(undefined);
  await turn;
});
