import assert from "node:assert/strict";
import test from "node:test";
import { CdpSessionManager, CdpTargetDiscoveryLike } from "../../src/cdp/CdpSessionManager.js";
import { CdpTransport, CdpTransportConnectOptions, CdpTransportSession } from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { RuntimeGenerationTracker, runtimeGenerationNumber } from "../../src/domain/RuntimeGeneration.js";
import {
  CdpAttachFailedError,
  CdpDisconnectedError,
  CdpNavigationFailedError,
  RuntimeGenerationChangedError,
} from "../../src/domain/errors.js";

const config = { cdpHost: "127.0.0.1" as const, cdpPort: 9223 };
const target: CdpTargetInfo = {
  id: "target-1",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/target-1",
  url: "https://chatgpt.com/c/test",
};

class StaticDiscovery implements CdpTargetDiscoveryLike {
  public calls = 0;
  public async findPrimaryTarget(): Promise<CdpTargetInfo> {
    this.calls += 1;
    return target;
  }
}

class FakeSession implements CdpTransportSession {
  public closeCalls = 0;
  public readonly navigations: string[] = [];
  public navigationFailure: Error | null = null;
  private listeners = new Set<() => void>();

  public async close(): Promise<void> {
    this.closeCalls += 1;
  }

  public onDisconnect(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async navigate(url: string): Promise<void> {
    this.navigations.push(url);
    if (this.navigationFailure) {
      throw this.navigationFailure;
    }
  }

  public emitDisconnect(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

class HangingTransport implements CdpTransport {
  public observedAbort = false;

  public async connect(options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    return await new Promise<CdpTransportSession>((_resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => {
          this.observedAbort = true;
          reject(options.signal?.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    });
  }
}

class FakeTransport implements CdpTransport {
  public readonly sessions: FakeSession[] = [];
  public fail = false;
  public beforeResolve: (() => void) | null = null;

  public async connect(_options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    if (this.fail) {
      throw new Error("synthetic transport failure");
    }
    this.beforeResolve?.();
    const session = new FakeSession();
    this.sessions.push(session);
    return session;
  }
}

function createRuntime(): RuntimeGenerationTracker {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 100, creationTime: "A" });
  return runtime;
}

test("connect binds the selected target to the current runtime lease", async () => {
  const runtime = createRuntime();
  const discovery = new StaticDiscovery();
  const transport = new FakeTransport();
  const manager = new CdpSessionManager(config, runtime, { discovery, transport, attachTimeoutMs: 50 });

  await manager.connect();
  assert.equal(manager.state, "CONNECTED");
  assert.equal(manager.targetId, "target-1");
  assert.equal(runtimeGenerationNumber(manager.boundGeneration!), 1);
  manager.assertCurrentRuntime();

  await manager.connect();
  assert.equal(discovery.calls, 1, "same-generation connect should be idempotent");
  assert.equal(transport.sessions.length, 1);
});

test("reconnect disposes the previous session and binds the new runtime generation", async () => {
  const runtime = createRuntime();
  const discovery = new StaticDiscovery();
  const transport = new FakeTransport();
  const manager = new CdpSessionManager(config, runtime, { discovery, transport, attachTimeoutMs: 50 });

  await manager.connect();
  const firstSession = transport.sessions[0]!;
  runtime.observe({ pid: 200, creationTime: "B" });
  assert.throws(() => manager.assertCurrentRuntime(), RuntimeGenerationChangedError);

  await manager.connect();
  assert.equal(firstSession.closeCalls, 1);
  assert.equal(transport.sessions.length, 2);
  assert.equal(runtimeGenerationNumber(manager.boundGeneration!), 2);
  assert.equal(manager.state, "CONNECTED");
});

test("transport attach failure is normalized to a stable CDP error", async () => {
  const runtime = createRuntime();
  const transport = new FakeTransport();
  transport.fail = true;
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new StaticDiscovery(),
    transport,
    attachTimeoutMs: 50,
  });

  await assert.rejects(() => manager.connect(), CdpAttachFailedError);
  assert.equal(manager.state, "FAILED");
});

test("runtime replacement during attach closes the new session and rejects stale binding", async () => {
  const runtime = createRuntime();
  const transport = new FakeTransport();
  transport.beforeResolve = () => runtime.observe({ pid: 200, creationTime: "B" });
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new StaticDiscovery(),
    transport,
    attachTimeoutMs: 50,
  });

  await assert.rejects(() => manager.connect(), RuntimeGenerationChangedError);
  assert.equal(transport.sessions[0]?.closeCalls, 1);
  assert.equal(manager.state, "FAILED");
  assert.equal(manager.boundGeneration, null);
});

test("transport disconnect event clears manager state and explicit disconnect closes a live session", async () => {
  const runtime = createRuntime();
  const transport = new FakeTransport();
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new StaticDiscovery(),
    transport,
    attachTimeoutMs: 50,
  });

  await manager.connect();
  transport.sessions[0]!.emitDisconnect();
  assert.equal(manager.state, "DISCONNECTED");
  assert.throws(() => manager.assertCurrentRuntime(), CdpDisconnectedError);

  await manager.connect();
  const live = transport.sessions[1]!;
  await manager.disconnect();
  assert.equal(live.closeCalls, 1);
  assert.equal(manager.state, "DISCONNECTED");
});

test("attach timeout aborts the underlying transport signal", async () => {
  const runtime = createRuntime();
  const transport = new HangingTransport();
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new StaticDiscovery(),
    transport,
    attachTimeoutMs: 20,
  });

  await assert.rejects(() => manager.connect(), CdpAttachFailedError);
  assert.equal(transport.observedAbort, true);
  assert.equal(manager.state, "FAILED");
});

test("navigate refuses disconnected sessions", async () => {
  const manager = new CdpSessionManager(config, createRuntime(), {
    discovery: new StaticDiscovery(),
    transport: new FakeTransport(),
    attachTimeoutMs: 50,
  });

  await assert.rejects(() => manager.navigate("https://chatgpt.com/"), CdpDisconnectedError);
});

test("navigate revalidates runtime lease and delegates only through the typed transport primitive", async () => {
  const runtime = createRuntime();
  const transport = new FakeTransport();
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new StaticDiscovery(),
    transport,
    attachTimeoutMs: 50,
  });
  await manager.connect();

  await manager.navigate("https://chatgpt.com/c/synthetic-route");
  assert.deepEqual(transport.sessions[0]!.navigations, ["https://chatgpt.com/c/synthetic-route"]);

  runtime.observe({ pid: 200, creationTime: "B" });
  await assert.rejects(
    () => manager.navigate("https://chatgpt.com/c/should-not-run"),
    RuntimeGenerationChangedError,
  );
  assert.deepEqual(transport.sessions[0]!.navigations, ["https://chatgpt.com/c/synthetic-route"]);
});

test("transport navigation failures are normalized at the CDP boundary", async () => {
  const runtime = createRuntime();
  const transport = new FakeTransport();
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new StaticDiscovery(),
    transport,
    attachTimeoutMs: 50,
  });
  await manager.connect();
  transport.sessions[0]!.navigationFailure = new Error("synthetic upstream details");

  await assert.rejects(
    () => manager.navigate("https://chatgpt.com/c/synthetic-route"),
    (error: unknown) =>
      error instanceof CdpNavigationFailedError &&
      error.code === "CDP_NAVIGATION_FAILED" &&
      !error.message.includes("synthetic-route") &&
      !error.message.includes("upstream details"),
  );
});
