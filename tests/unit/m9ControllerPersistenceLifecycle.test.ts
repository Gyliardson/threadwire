import assert from "node:assert/strict";
import test from "node:test";
import {
  ThreadwireController,
  ThreadwireControllerDependencies,
} from "../../src/controller/ThreadwireController.js";

function dependencies(events: string[]): ThreadwireControllerDependencies {
  return {
    runtime: {
      inspect: async () => ({ isRunning: false }),
      ensureStarted: async () => undefined,
    },
    cdp: {
      state: "DISCONNECTED",
      connect: async () => undefined,
      disconnect: async () => {
        events.push("cdp.close");
      },
      assertCurrentRuntime: () => undefined,
    },
    registry: {
      resolve: () => undefined,
      knownThreads: () => [],
      close: () => {
        events.push("registry.close");
      },
    },
    router: {
      routeFresh: async () => undefined,
      routeToThread: async () => undefined,
    },
    executor: {
      executeStreaming: async () => {
        throw new Error("not used");
      },
    },
  };
}

test("controller close disconnects CDP then closes persistent registry", async () => {
  const events: string[] = [];
  const controller = new ThreadwireController(dependencies(events));

  await controller.close();

  assert.deepEqual(events, ["cdp.close", "registry.close"]);
});

test("controller still closes persistent registry when CDP disconnect fails", async () => {
  const events: string[] = [];
  const fixture = dependencies(events);
  fixture.cdp.disconnect = async () => {
    events.push("cdp.close");
    throw new Error("synthetic disconnect failure");
  };
  const controller = new ThreadwireController(fixture);

  await assert.rejects(controller.close(), /synthetic disconnect failure/);
  assert.deepEqual(events, ["cdp.close", "registry.close"]);
});
