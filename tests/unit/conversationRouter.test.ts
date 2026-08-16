import assert from "node:assert/strict";
import test from "node:test";
import { ThreadHandle, createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import {
  RouteNavigationFailedError,
  RuntimeGenerationChangedError,
  ThreadNotFoundError,
} from "../../src/domain/errors.js";
import {
  CHATGPT_FRESH_ROUTE,
  ConversationNavigationPort,
  ConversationRouter,
} from "../../src/routing/ConversationRouter.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";
import { ThreadRegistry } from "../../src/routing/ThreadRegistry.js";
import { RuntimeGenerationTracker } from "../../src/domain/RuntimeGeneration.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function createRuntime(): RuntimeGenerationTracker {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 100, creationTime: "runtime-a" });
  return runtime;
}

class RecordingNavigation implements ConversationNavigationPort {
  public readonly urls: string[] = [];
  public failure: Error | null = null;
  public block: Deferred<void> | null = null;

  public async navigate(url: string): Promise<void> {
    this.urls.push(url);
    if (this.failure) {
      throw this.failure;
    }
    if (this.block) {
      const gate = this.block;
      this.block = null;
      await gate.promise;
    }
  }
}

function createHarness(): {
  readonly runtime: RuntimeGenerationTracker;
  readonly scheduler: OperationScheduler;
  readonly registry: ThreadRegistry;
  readonly navigation: RecordingNavigation;
  readonly router: ConversationRouter;
  readonly handleA: ThreadHandle;
  readonly handleB: ThreadHandle;
} {
  const runtime = createRuntime();
  const scheduler = new OperationScheduler(runtime);
  const registry = new ThreadRegistry({
    handleFactory: (() => {
      const values = ["handle-a", "handle-b"];
      let index = 0;
      return () => values[index++] ?? `extra-${index}`;
    })(),
  });
  const handleA = registry.register(createConversationLocator("https://chatgpt.com/c/synthetic-a"));
  const handleB = registry.register(createConversationLocator("https://chatgpt.com/c/synthetic-b"));
  const navigation = new RecordingNavigation();
  const router = new ConversationRouter(registry, scheduler, navigation);
  return { runtime, scheduler, registry, navigation, router, handleA, handleB };
}

test("unknown ThreadHandle performs no navigation", async () => {
  const { router, navigation } = createHarness();
  await assert.rejects(router.routeToThread("tw_unknown" as ThreadHandle), ThreadNotFoundError);
  assert.deepEqual(navigation.urls, []);
});

test("known existing thread resolves internally and outward result contains only the opaque handle", async () => {
  const { router, navigation, handleA } = createHarness();
  const result = await router.routeToThread(handleA);

  assert.deepEqual(navigation.urls, ["https://chatgpt.com/c/synthetic-a"]);
  assert.deepEqual(result, { kind: "THREAD", threadHandle: handleA });
  assert.equal(JSON.stringify(result).includes("synthetic-a"), false);
});

test("routeFresh navigates to root and allocates no ThreadHandle", async () => {
  let handleCalls = 0;
  const runtime = createRuntime();
  const registry = new ThreadRegistry({
    handleFactory: () => {
      handleCalls += 1;
      return `handle-${handleCalls}`;
    },
  });
  registry.register(createConversationLocator("https://chatgpt.com/c/synthetic-existing"));
  const before = handleCalls;
  const navigation = new RecordingNavigation();
  const router = new ConversationRouter(registry, new OperationScheduler(runtime), navigation);

  const result = await router.routeFresh();
  assert.deepEqual(result, { kind: "FRESH" });
  assert.deepEqual(navigation.urls, [CHATGPT_FRESH_ROUTE]);
  assert.equal(handleCalls, before);
  assert.equal("threadHandle" in result, false);
});

test("concurrent route requests are serialized through the shared scheduler", async () => {
  const { router, navigation, handleA, handleB } = createHarness();
  const firstGate = deferred<void>();
  navigation.block = firstGate;

  const first = router.routeToThread(handleA);
  const second = router.routeToThread(handleB);
  await Promise.resolve();
  assert.deepEqual(navigation.urls, ["https://chatgpt.com/c/synthetic-a"]);

  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(navigation.urls, [
    "https://chatgpt.com/c/synthetic-a",
    "https://chatgpt.com/c/synthetic-b",
  ]);
});

test("route waits behind an active synthetic TURN and then navigates when generation remains current", async () => {
  const { router, scheduler, navigation, handleA } = createHarness();
  const turnGate = deferred<void>();
  const turn = scheduler.schedule("TURN", async () => await turnGate.promise);
  const route = router.routeToThread(handleA);

  await Promise.resolve();
  assert.deepEqual(navigation.urls, []);
  turnGate.resolve();
  await Promise.all([turn, route]);
  assert.deepEqual(navigation.urls, ["https://chatgpt.com/c/synthetic-a"]);
});

test("stale queued route rejects before navigation", async () => {
  const { runtime, router, scheduler, navigation, handleA } = createHarness();
  const turnGate = deferred<void>();
  const turn = scheduler.schedule("TURN", async () => await turnGate.promise);
  const route = router.routeToThread(handleA);

  runtime.observe({ pid: 200, creationTime: "runtime-b" });
  turnGate.resolve();
  await turn;
  await assert.rejects(route, RuntimeGenerationChangedError);
  assert.deepEqual(navigation.urls, []);
});

test("navigation failure is normalized without locator or upstream error leakage", async () => {
  const { router, navigation, handleA } = createHarness();
  navigation.failure = new Error("upstream synthetic-a secret detail");

  await assert.rejects(
    router.routeToThread(handleA),
    (error: unknown) =>
      error instanceof RouteNavigationFailedError &&
      error.code === "ROUTE_NAVIGATION_FAILED" &&
      !error.message.includes("synthetic-a") &&
      !error.message.includes("secret detail"),
  );
});

test("router completes when the navigation command completes and performs no readiness phase", async () => {
  const { router, navigation, handleA } = createHarness();
  const result = await router.routeToThread(handleA);
  assert.equal(navigation.urls.length, 1);
  assert.deepEqual(result, { kind: "THREAD", threadHandle: handleA });
});
