import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeLease, RuntimeGenerationTracker } from "../../src/domain/RuntimeGeneration.js";
import { ThreadHandle, createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import {
  ExistingRouteReadinessTimeoutError,
  RouteNavigationFailedError,
  RuntimeGenerationChangedError,
  ThreadNotFoundError,
} from "../../src/domain/errors.js";
import {
  CHATGPT_FRESH_ROUTE,
  ConversationNavigationPort,
  ConversationRouter,
  ExistingRouteReadinessPort,
} from "../../src/routing/ConversationRouter.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";
import { ThreadRegistry } from "../../src/routing/ThreadRegistry.js";

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void; }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createRuntime(): RuntimeGenerationTracker {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 100, creationTime: "runtime-a" });
  return runtime;
}

class RecordingNavigation implements ConversationNavigationPort {
  public readonly urls: string[] = [];
  public readonly events: string[];
  public failure: Error | null = null;
  public constructor(events: string[]) { this.events = events; }
  public async navigate(url: string): Promise<void> {
    this.urls.push(url);
    this.events.push("navigate");
    if (this.failure) throw this.failure;
  }
}

class ControlledReadiness implements ExistingRouteReadinessPort {
  public calls = 0;
  public readonly events: string[];
  public gate: Deferred<void> | null = null;
  public failure: Error | null = null;
  public leases: RuntimeLease[] = [];
  public constructor(events: string[]) { this.events = events; }
  public async waitForExistingRoute(_locator: ReturnType<typeof createConversationLocator>, lease: RuntimeLease): Promise<void> {
    this.calls += 1;
    this.leases.push(lease);
    this.events.push("readiness");
    if (this.failure) throw this.failure;
    if (this.gate) await this.gate.promise;
    this.events.push("ready");
  }
}

function createHarness() {
  const runtime = createRuntime();
  const scheduler = new OperationScheduler(runtime);
  const registry = new ThreadRegistry({ handleFactory: (() => {
    const values = ["handle-a", "handle-b"]; let i = 0; return () => values[i++] ?? `extra-${i}`;
  })() });
  const handleA = registry.register(createConversationLocator("https://chatgpt.com/c/synthetic-a"));
  const handleB = registry.register(createConversationLocator("https://chatgpt.com/c/synthetic-b"));
  const events: string[] = [];
  const navigation = new RecordingNavigation(events);
  const readiness = new ControlledReadiness(events);
  const router = new ConversationRouter(registry, scheduler, navigation, readiness);
  return { runtime, scheduler, registry, navigation, readiness, router, handleA, handleB, events };
}

test("unknown ThreadHandle performs no navigation or readiness", async () => {
  const { router, navigation, readiness } = createHarness();
  await assert.rejects(router.routeToThread("tw_unknown" as ThreadHandle), ThreadNotFoundError);
  assert.deepEqual(navigation.urls, []);
  assert.equal(readiness.calls, 0);
});

test("existing route navigates before readiness and returns only the opaque handle", async () => {
  const { router, events, handleA } = createHarness();
  const result = await router.routeToThread(handleA);
  assert.deepEqual(events, ["navigate", "readiness", "ready"]);
  assert.deepEqual(result, { kind: "THREAD", threadHandle: handleA });
  assert.equal(JSON.stringify(result).includes("synthetic-a"), false);
});

test("routeToThread does not resolve until readiness completes", async () => {
  const { router, readiness, handleA } = createHarness();
  const gate = deferred<void>(); readiness.gate = gate;
  let settled = false;
  const route = router.routeToThread(handleA).then((v) => { settled = true; return v; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  gate.resolve();
  await route;
  assert.equal(settled, true);
});

test("second route waits for first route readiness inside the same ROUTE slot", async () => {
  const { router, readiness, navigation, handleA, handleB } = createHarness();
  const gate = deferred<void>(); readiness.gate = gate;
  const first = router.routeToThread(handleA);
  const second = router.routeToThread(handleB);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(navigation.urls, ["https://chatgpt.com/c/synthetic-a"]);
  gate.resolve(); readiness.gate = null;
  await Promise.all([first, second]);
  assert.deepEqual(navigation.urls, ["https://chatgpt.com/c/synthetic-a", "https://chatgpt.com/c/synthetic-b"]);
});

test("synthetic TURN queued behind route waits for readiness", async () => {
  const { router, readiness, scheduler, handleA } = createHarness();
  const gate = deferred<void>(); readiness.gate = gate;
  const events: string[] = [];
  const route = router.routeToThread(handleA);
  const turn = scheduler.schedule("TURN", async () => { events.push("turn"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
  gate.resolve();
  await Promise.all([route, turn]);
  assert.deepEqual(events, ["turn"]);
});

test("readiness failure releases scheduler for later work", async () => {
  const { router, readiness, scheduler, handleA } = createHarness();
  readiness.failure = new ExistingRouteReadinessTimeoutError();
  await assert.rejects(router.routeToThread(handleA), ExistingRouteReadinessTimeoutError);
  let ran = false;
  await scheduler.schedule("TURN", async () => { ran = true; });
  assert.equal(ran, true);
});

test("routeFresh retains M2 navigation-command boundary and does not invoke existing readiness", async () => {
  const { router, readiness, navigation } = createHarness();
  const result = await router.routeFresh();
  assert.deepEqual(result, { kind: "FRESH" });
  assert.deepEqual(navigation.urls, [CHATGPT_FRESH_ROUTE]);
  assert.equal(readiness.calls, 0);
});

test("stale queued existing route rejects before navigation or readiness", async () => {
  const { runtime, router, scheduler, navigation, readiness, handleA } = createHarness();
  const gate = deferred<void>();
  const turn = scheduler.schedule("TURN", async () => await gate.promise);
  const route = router.routeToThread(handleA);
  runtime.observe({ pid: 200, creationTime: "runtime-b" });
  gate.resolve(); await turn;
  await assert.rejects(route, RuntimeGenerationChangedError);
  assert.deepEqual(navigation.urls, []);
  assert.equal(readiness.calls, 0);
});

test("navigation failure is normalized without locator or upstream leakage", async () => {
  const { router, navigation, readiness, handleA } = createHarness();
  navigation.failure = new Error("upstream synthetic-a secret detail");
  await assert.rejects(router.routeToThread(handleA), (error: unknown) =>
    error instanceof RouteNavigationFailedError && !error.message.includes("synthetic-a") && !error.message.includes("secret detail"));
  assert.equal(readiness.calls, 0);
});
