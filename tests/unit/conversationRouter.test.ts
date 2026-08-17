import assert from "node:assert/strict";
import test from "node:test";
import { withTimeout } from "../../src/utils/timeout.js";
import {
  RuntimeGenerationTracker,
  RuntimeLease,
} from "../../src/domain/RuntimeGeneration.js";
import { ThreadHandle, ConversationLocator, createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import {
  ExistingRouteReadinessTimeoutError,
  RouteNavigationFailedError,
  RuntimeGenerationChangedError,
  ThreadNotFoundError,
} from "../../src/domain/errors.js";
import {
  CHATGPT_FRESH_ROUTE,
  ConversationNavigationPort,
  ConversationReadinessPort,
  ConversationRouter,
} from "../../src/routing/ConversationRouter.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";
import { ThreadRegistry } from "../../src/routing/ThreadRegistry.js";

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
  public readonly events: string[];

  public constructor(events: string[] = []) {
    this.events = events;
  }

  public async navigate(url: string): Promise<void> {
    this.urls.push(url);
    this.events.push("navigate");
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

class ControlledReadiness implements ConversationReadinessPort {
  public existingCalls = 0;
  public freshCalls = 0;
  public block: Deferred<void> | null = null;
  public failure: Error | null = null;

  public constructor(private readonly events: string[] = []) {}

  public async waitForExistingRoute(
    _locator: ConversationLocator,
    _lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    this.existingCalls += 1;
    this.events.push("readiness");
    if (this.failure) throw this.failure;
    if (this.block) {
      await withTimeout(() => this.block!.promise, 5000, signal ? { signal } : {});
    }
    this.events.push("ready");
  }

  public async waitForFreshRoute(
    _lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    this.freshCalls += 1;
    this.events.push("fresh_readiness");
    if (this.failure) throw this.failure;
    if (this.block) {
      await withTimeout(() => this.block!.promise, 5000, signal ? { signal } : {});
    }
    this.events.push("fresh_ready");
  }
}

function createHarness(): {
  readonly runtime: RuntimeGenerationTracker;
  readonly scheduler: OperationScheduler;
  readonly registry: ThreadRegistry;
  readonly navigation: RecordingNavigation;
  readonly readiness: ControlledReadiness;
  readonly router: ConversationRouter;
  readonly handleA: ThreadHandle;
  readonly handleB: ThreadHandle;
  readonly events: string[];
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
  const events: string[] = [];
  const navigation = new RecordingNavigation(events);
  const readiness = new ControlledReadiness(events);
  const router = new ConversationRouter(registry, scheduler, navigation, readiness);
  return { runtime, scheduler, registry, navigation, readiness, router, handleA, handleB, events };
}

test("unknown ThreadHandle performs no navigation", async () => {
  const { router, navigation, readiness } = createHarness();
  await assert.rejects(router.routeToThread("tw_unknown" as ThreadHandle), ThreadNotFoundError);
  assert.deepEqual(navigation.urls, []);
  assert.equal(readiness.existingCalls, 0);
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
  const readiness = new ControlledReadiness();
  const router = new ConversationRouter(
    registry,
    new OperationScheduler(runtime),
    navigation,
    readiness,
  );

  const result = await router.routeFresh();
  assert.deepEqual(result, { kind: "FRESH" });
  assert.deepEqual(navigation.urls, [CHATGPT_FRESH_ROUTE]);
  assert.equal(handleCalls, before);
  assert.equal("threadHandle" in result, false);
  assert.equal(readiness.existingCalls, 0);
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
  const { runtime, router, scheduler, navigation, readiness, handleA } = createHarness();
  const turnGate = deferred<void>();
  const turn = scheduler.schedule("TURN", async () => await turnGate.promise);
  const route = router.routeToThread(handleA);

  runtime.observe({ pid: 200, creationTime: "runtime-b" });
  turnGate.resolve();
  await turn;
  await assert.rejects(route, RuntimeGenerationChangedError);
  assert.deepEqual(navigation.urls, []);
  assert.equal(readiness.existingCalls, 0);
});

test("navigation failure is normalized without locator or upstream error leakage", async () => {
  const { router, navigation, readiness, handleA } = createHarness();
  navigation.failure = new Error("upstream synthetic-a secret detail");

  await assert.rejects(
    router.routeToThread(handleA),
    (error: unknown) =>
      error instanceof RouteNavigationFailedError &&
      error.code === "ROUTE_NAVIGATION_FAILED" &&
      !error.message.includes("synthetic-a") &&
      !error.message.includes("secret detail"),
  );
  assert.equal(readiness.existingCalls, 0);
});

test("existing route success boundary is navigation followed by readiness completion", async () => {
  const { router, navigation, readiness, events, handleA } = createHarness();
  const readinessGate = deferred<void>();
  readiness.block = readinessGate;
  let settled = false;

  const route = router.routeToThread(handleA).then((result) => {
    settled = true;
    return result;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(navigation.urls, ["https://chatgpt.com/c/synthetic-a"]);
  assert.deepEqual(events, ["navigate", "readiness"]);
  assert.equal(settled, false);

  readinessGate.resolve();
  assert.deepEqual(await route, { kind: "THREAD", threadHandle: handleA });
  assert.equal(settled, true);
  assert.deepEqual(events, ["navigate", "readiness", "ready"]);
});

test("concurrent second route waits until first route readiness releases the ROUTE slot", async () => {
  const { router, navigation, readiness, handleA, handleB } = createHarness();
  const readinessGate = deferred<void>();
  readiness.block = readinessGate;

  const first = router.routeToThread(handleA);
  const second = router.routeToThread(handleB);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(navigation.urls, ["https://chatgpt.com/c/synthetic-a"]);
  readinessGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(navigation.urls, [
    "https://chatgpt.com/c/synthetic-a",
    "https://chatgpt.com/c/synthetic-b",
  ]);
});

test("synthetic TURN queued behind existing route waits for readiness", async () => {
  const { router, scheduler, readiness, handleA } = createHarness();
  const readinessGate = deferred<void>();
  readiness.block = readinessGate;
  const events: string[] = [];

  const route = router.routeToThread(handleA);
  const turn = scheduler.schedule("TURN", async () => {
    events.push("turn");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);

  readinessGate.resolve();
  await Promise.all([route, turn]);
  assert.deepEqual(events, ["turn"]);
});

test("readiness failure releases scheduler so later work can continue", async () => {
  const { router, scheduler, readiness, handleA } = createHarness();
  readiness.failure = new ExistingRouteReadinessTimeoutError();

  await assert.rejects(router.routeToThread(handleA), ExistingRouteReadinessTimeoutError);
  let laterRan = false;
  await scheduler.schedule("TURN", async () => {
    laterRan = true;
  });
  assert.equal(laterRan, true);
});

test("routeFresh never invokes existing readiness", async () => {
  const { router, readiness } = createHarness();
  await router.routeFresh();
  assert.equal(readiness.existingCalls, 0);
});
