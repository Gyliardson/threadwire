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

test("client abort after destructive recovery starts must not release mutation serialization before lifecycle quiescence", async () => {
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
        calls.push("runtime.restart");
        restartStarted.resolve(undefined);
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => reject(new Error("synthetic client abort"));
          signal?.addEventListener("abort", onAbort, { once: true });
          lifecycleQuiesced.promise.then(resolve, reject).finally(() => {
            signal?.removeEventListener("abort", onAbort);
          });
        });
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
  await assert.rejects(recovery, /synthetic client abort/);

  const nextTurn = controller.executeTurn(
    { target: { kind: "FRESH" }, prompt: "fixture" },
    () => undefined,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(
    calls.includes("runtime.ensureStarted"),
    false,
    "next mutation entered while the destructive restart lifecycle was still not quiescent",
  );

  lifecycleQuiesced.resolve(undefined);
  await nextTurn;
  assert.equal(calls.includes("executor.executeStreaming"), true);
});
