import assert from "node:assert/strict";
import test from "node:test";
import { CdpSessionManager, CdpTargetDiscoveryLike } from "../../src/cdp/CdpSessionManager.js";
import { CdpTransport, CdpTransportConnectOptions, CdpTransportSession } from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import { RuntimeGenerationTracker, runtimeGenerationNumber } from "../../src/domain/RuntimeGeneration.js";
import {
  CdpAttachFailedError,
  CdpDisconnectedError,
  CdpNavigationFailedError,
  CdpReadinessFailedError,
  RuntimeGenerationChangedError,
} from "../../src/domain/errors.js";
import { ExistingReadinessSnapshot } from "../../src/readiness/types.js";

const config = { cdpHost: "127.0.0.1" as const, cdpPort: 9223 };
const target: CdpTargetInfo = {
  id: "target-1", title: "ChatGPT", type: "page", description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/target-1",
  url: "https://chatgpt.com/c/test",
};
const locator = createConversationLocator("https://chatgpt.com/c/synthetic-route");
const readySnapshot: ExistingReadinessSnapshot = {
  mainFrame: { frameId: "main", loaderId: "loader", expectedRoute: true },
  eligibleEditables: [{ backendDOMNodeId: 101, focused: true }],
  backendActivity: { activeCount: 0, activityEpoch: 2 },
};

class StaticDiscovery implements CdpTargetDiscoveryLike {
  public calls = 0;
  public async findPrimaryTarget(): Promise<CdpTargetInfo> { this.calls += 1; return target; }
}

class FakeSession implements CdpTransportSession {
  public closeCalls = 0;
  public initializeCalls = 0;
  public readonly navigations: string[] = [];
  public readonly focuses: number[] = [];
  public snapshotCalls = 0;
  public navigationFailure: Error | null = null;
  public initializationFailure: Error | null = null;
  public readinessFailure: Error | null = null;
  public focusFailure: Error | null = null;
  public beforeFocusResolve: (() => void) | null = null;
  public readonly events: string[] = [];
  private listeners = new Set<() => void>();

  public async close(): Promise<void> { this.closeCalls += 1; }
  public onDisconnect(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  public async initializeReadinessObservation(): Promise<void> {
    this.initializeCalls += 1; this.events.push("initialize");
    if (this.initializationFailure) throw this.initializationFailure;
  }
  public async navigate(url: string): Promise<void> {
    this.navigations.push(url); this.events.push("navigate");
    if (this.navigationFailure) throw this.navigationFailure;
  }
  public async getReadinessSnapshot(): Promise<ExistingReadinessSnapshot> {
    this.snapshotCalls += 1;
    if (this.readinessFailure) throw this.readinessFailure;
    return readySnapshot;
  }
  public async focusBackendNode(id: number): Promise<void> {
    this.focuses.push(id);
    if (this.focusFailure) throw this.focusFailure;
    this.beforeFocusResolve?.();
  }
  public emitDisconnect(): void { for (const listener of [...this.listeners]) listener(); }
}

class HangingTransport implements CdpTransport {
  public observedAbort = false;
  public async connect(options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    return await new Promise<CdpTransportSession>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        this.observedAbort = true; reject(options.signal?.reason ?? new Error("aborted"));
      }, { once: true });
    });
  }
}

class FakeTransport implements CdpTransport {
  public readonly sessions: FakeSession[] = [];
  public fail = false;
  public beforeResolve: (() => void) | null = null;
  public configureSession: ((session: FakeSession) => void) | null = null;
  public async connect(_options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    if (this.fail) throw new Error("synthetic transport failure");
    this.beforeResolve?.();
    const session = new FakeSession(); this.configureSession?.(session); this.sessions.push(session); return session;
  }
}

function createRuntime(): RuntimeGenerationTracker {
  const runtime = new RuntimeGenerationTracker(); runtime.observe({ pid: 100, creationTime: "A" }); return runtime;
}

function createManager(runtime = createRuntime(), transport = new FakeTransport()) {
  const manager = new CdpSessionManager(config, runtime, { discovery: new StaticDiscovery(), transport, attachTimeoutMs: 50 });
  return { manager, runtime, transport };
}

test("connect binds target, initializes readiness observation, and remains idempotent", async () => {
  const runtime = createRuntime(); const discovery = new StaticDiscovery(); const transport = new FakeTransport();
  const manager = new CdpSessionManager(config, runtime, { discovery, transport, attachTimeoutMs: 50 });
  await manager.connect();
  assert.equal(manager.state, "CONNECTED"); assert.equal(manager.targetId, "target-1");
  assert.equal(runtimeGenerationNumber(manager.boundGeneration!), 1);
  assert.equal(transport.sessions[0]!.initializeCalls, 1);
  await manager.connect(); assert.equal(discovery.calls, 1); assert.equal(transport.sessions.length, 1);
});

test("Network readiness initialization completes before M3 navigation can run", async () => {
  const { manager, transport } = createManager(); await manager.connect();
  await manager.navigate(locator);
  assert.deepEqual(transport.sessions[0]!.events, ["initialize", "navigate"]);
});

test("readiness initialization failure is normalized and closes candidate session", async () => {
  const transport = new FakeTransport();
  transport.configureSession = (session) => { session.initializationFailure = new Error("raw network enable detail"); };
  const { manager } = createManager(createRuntime(), transport);
  await assert.rejects(() => manager.connect(), (error: unknown) =>
    error instanceof CdpReadinessFailedError && !error.message.includes("raw network enable detail"));
  assert.equal(transport.sessions[0]!.closeCalls, 1); assert.equal(manager.state, "FAILED");
});

test("reconnect disposes previous session and binds new generation", async () => {
  const { manager, runtime, transport } = createManager(); await manager.connect(); const first = transport.sessions[0]!;
  runtime.observe({ pid: 200, creationTime: "B" }); assert.throws(() => manager.assertCurrentRuntime(), RuntimeGenerationChangedError);
  await manager.connect(); assert.equal(first.closeCalls, 1); assert.equal(transport.sessions.length, 2); assert.equal(runtimeGenerationNumber(manager.boundGeneration!), 2);
});

test("transport attach failure is normalized", async () => {
  const transport = new FakeTransport(); transport.fail = true; const { manager } = createManager(createRuntime(), transport);
  await assert.rejects(() => manager.connect(), CdpAttachFailedError); assert.equal(manager.state, "FAILED");
});

test("runtime replacement during attach closes new session and rejects stale binding", async () => {
  const runtime = createRuntime(); const transport = new FakeTransport();
  transport.beforeResolve = () => runtime.observe({ pid: 200, creationTime: "B" });
  const { manager } = createManager(runtime, transport);
  await assert.rejects(() => manager.connect(), RuntimeGenerationChangedError);
  assert.equal(transport.sessions[0]?.closeCalls, 1); assert.equal(manager.boundGeneration, null);
});

test("disconnect event clears manager state and explicit disconnect closes live session", async () => {
  const { manager, transport } = createManager(); await manager.connect(); transport.sessions[0]!.emitDisconnect();
  assert.equal(manager.state, "DISCONNECTED"); assert.throws(() => manager.assertCurrentRuntime(), CdpDisconnectedError);
  await manager.connect(); const live = transport.sessions[1]!; await manager.disconnect(); assert.equal(live.closeCalls, 1);
});

test("attach timeout aborts underlying transport signal", async () => {
  const transport = new HangingTransport(); const manager = new CdpSessionManager(config, createRuntime(), { discovery: new StaticDiscovery(), transport, attachTimeoutMs: 20 });
  await assert.rejects(() => manager.connect(), CdpAttachFailedError); assert.equal(transport.observedAbort, true);
});

test("navigate refuses disconnected sessions", async () => {
  const { manager } = createManager(); await assert.rejects(() => manager.navigate("https://chatgpt.com/"), CdpDisconnectedError);
});

test("navigate revalidates runtime and transport failures remain normalized", async () => {
  const { manager, runtime, transport } = createManager(); await manager.connect();
  await manager.navigate(locator); assert.deepEqual(transport.sessions[0]!.navigations, [locator]);
  runtime.observe({ pid: 200, creationTime: "B" });
  await assert.rejects(() => manager.navigate("https://chatgpt.com/c/should-not-run"), RuntimeGenerationChangedError);
  assert.deepEqual(transport.sessions[0]!.navigations, [locator]);
});

test("transport navigation failure does not leak upstream details", async () => {
  const { manager, transport } = createManager(); await manager.connect();
  transport.sessions[0]!.navigationFailure = new Error("synthetic-route upstream secret");
  await assert.rejects(() => manager.navigate(locator), (error: unknown) =>
    error instanceof CdpNavigationFailedError && !error.message.includes("synthetic-route") && !error.message.includes("secret"));
});

test("readiness snapshot delegates only while the captured RuntimeLease remains current", async () => {
  const { manager, runtime, transport } = createManager(); await manager.connect(); const lease = runtime.getCurrentRuntimeLease();
  assert.deepEqual(await manager.getReadinessSnapshot(locator, lease), readySnapshot);
  runtime.observe({ pid: 200, creationTime: "B" });
  await assert.rejects(() => manager.getReadinessSnapshot(locator, lease), RuntimeGenerationChangedError);
  assert.equal(transport.sessions[0]!.snapshotCalls, 1);
});

test("runtime replacement immediately before DOM.focus prevents the mutation", async () => {
  const { manager, runtime, transport } = createManager(); await manager.connect(); const lease = runtime.getCurrentRuntimeLease();
  runtime.observe({ pid: 200, creationTime: "B" });
  await assert.rejects(() => manager.focusBackendNode(101, lease), RuntimeGenerationChangedError);
  assert.deepEqual(transport.sessions[0]!.focuses, []);
});

test("runtime replacement after focus command but before verification rejects stale readiness", async () => {
  const { manager, runtime, transport } = createManager(); await manager.connect(); const lease = runtime.getCurrentRuntimeLease();
  transport.sessions[0]!.beforeFocusResolve = () => runtime.observe({ pid: 200, creationTime: "B" });
  await assert.rejects(() => manager.focusBackendNode(101, lease), RuntimeGenerationChangedError);
  assert.deepEqual(transport.sessions[0]!.focuses, [101]);
});

test("raw readiness CDP errors normalize without upstream detail leakage", async () => {
  const { manager, runtime, transport } = createManager(); await manager.connect(); const lease = runtime.getCurrentRuntimeLease();
  transport.sessions[0]!.readinessFailure = new Error("raw AX secret payload");
  await assert.rejects(() => manager.getReadinessSnapshot(locator, lease), (error: unknown) =>
    error instanceof CdpReadinessFailedError && !error.message.includes("raw AX secret payload"));
});
