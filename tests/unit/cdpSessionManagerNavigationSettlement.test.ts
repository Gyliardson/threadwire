import assert from "node:assert/strict";
import test from "node:test";
import { CdpSessionManager, CdpTargetDiscoveryLike } from "../../src/cdp/CdpSessionManager.js";
import {
  CdpNavigationSettlementTransportSession,
  CdpTransport,
  CdpTransportConnectOptions,
  CdpTransportSession,
} from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { RuntimeGenerationTracker } from "../../src/domain/RuntimeGeneration.js";
import {
  CdpDisconnectedError,
  CdpNavigationFailedError,
  OperationAbortedError,
  RuntimeGenerationChangedError,
} from "../../src/domain/errors.js";
import { ExistingReadinessSnapshot, RouteExpectation } from "../../src/readiness/types.js";

const config = { cdpHost: "127.0.0.1" as const, cdpPort: 9223 };
const target: CdpTargetInfo = {
  id: "target-settlement",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/target-settlement",
  url: "https://chatgpt.com/",
};

const freshRoute: RouteExpectation = {
  kind: "FRESH_ROOT",
};

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

class StaticDiscovery implements CdpTargetDiscoveryLike {
  public async findPrimaryTarget(): Promise<CdpTargetInfo> {
    return target;
  }
}

class FakeSettlementTransportSession implements CdpNavigationSettlementTransportSession {
  public settlementCalls: Array<{ url: string; expectedRoute: RouteExpectation }> = [];
  public settlementFailure: Error | null = null;
  public block: Deferred<void> | null = null;
  public signalObserved: AbortSignal | undefined = undefined;

  public async close(): Promise<void> {}
  public onDisconnect(_listener: () => void): () => void {
    return () => {};
  }
  public async initializeReadinessObservation(): Promise<void> {}
  public async navigate(_url: string): Promise<void> {}
  public async reload(): Promise<void> {}
  public async getReadinessSnapshot(_expectedRoute: RouteExpectation): Promise<ExistingReadinessSnapshot> {
    return {
      mainFrame: { frameId: "main", loaderId: "loader", expectedRoute: true },
      eligibleEditables: [],
      backendActivity: { activeCount: 0, activityEpoch: 0 },
    };
  }
  public async focusBackendNode(_backendDOMNodeId: number): Promise<void> {}

  public async navigateAndWaitForLoadSettlement(
    url: string,
    expectedRoute: RouteExpectation,
    signal?: AbortSignal,
  ): Promise<void> {
    this.signalObserved = signal;
    this.settlementCalls.push({ url, expectedRoute });
    if (this.settlementFailure) {
      throw this.settlementFailure;
    }
    if (this.block) {
      const gate = this.block;
      this.block = null;
      await gate.promise;
    }
  }
}

class PlainFakeSession implements CdpTransportSession {
  public async close(): Promise<void> {}
  public onDisconnect(_listener: () => void): () => void {
    return () => {};
  }
  public async initializeReadinessObservation(): Promise<void> {}
  public async navigate(_url: string): Promise<void> {}
  public async reload(): Promise<void> {}
  public async getReadinessSnapshot(_expectedRoute: RouteExpectation): Promise<ExistingReadinessSnapshot> {
    return {
      mainFrame: { frameId: "main", loaderId: "loader", expectedRoute: true },
      eligibleEditables: [],
      backendActivity: { activeCount: 0, activityEpoch: 0 },
    };
  }
  public async focusBackendNode(_backendDOMNodeId: number): Promise<void> {}
}

class StaticTransport implements CdpTransport {
  public constructor(public readonly session: CdpTransportSession) {}
  public async connect(_options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    return this.session;
  }
}

function createRuntime(): RuntimeGenerationTracker {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 100, creationTime: "runtime-a" });
  return runtime;
}

test("disconnected settled-navigation call rejects with CdpDisconnectedError", async () => {
  const runtime = createRuntime();
  const session = new FakeSettlementTransportSession();
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new StaticDiscovery(),
    transport: new StaticTransport(session),
  });

  await assert.rejects(
    manager.navigateAndWaitForLoadSettlement("https://chatgpt.com/", freshRoute),
    CdpDisconnectedError,
  );
});

test("correct transport capability delegates once and passes url and expectedRoute", async () => {
  const runtime = createRuntime();
  const session = new FakeSettlementTransportSession();
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new StaticDiscovery(),
    transport: new StaticTransport(session),
  });

  await manager.connect();
  await manager.navigateAndWaitForLoadSettlement("https://chatgpt.com/", freshRoute);

  assert.equal(session.settlementCalls.length, 1);
  assert.equal(session.settlementCalls[0]!.url, "https://chatgpt.com/");
  assert.deepEqual(session.settlementCalls[0]!.expectedRoute, freshRoute);
});

test("session lacking navigation settlement capability rejects with CdpNavigationFailedError", async () => {
  const runtime = createRuntime();
  const plainSession = new PlainFakeSession();
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new StaticDiscovery(),
    transport: new StaticTransport(plainSession),
  });

  await manager.connect();
  await assert.rejects(
    manager.navigateAndWaitForLoadSettlement("https://chatgpt.com/", freshRoute),
    CdpNavigationFailedError,
  );
});

test("navigation settlement timeout is configurable and rejects when deadline expires", async () => {
  const runtime = createRuntime();
  const session = new FakeSettlementTransportSession();
  session.block = deferred<void>();
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new StaticDiscovery(),
    transport: new StaticTransport(session),
    navigationSettlementTimeoutMs: 50,
  });

  await manager.connect();
  await assert.rejects(
    manager.navigateAndWaitForLoadSettlement("https://chatgpt.com/", freshRoute),
    CdpNavigationFailedError,
  );
});

test("parent abort preserves OperationAbortedError and does not wrap in CdpNavigationFailedError", async () => {
  const runtime = createRuntime();
  const session = new FakeSettlementTransportSession();
  session.block = deferred<void>();
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new StaticDiscovery(),
    transport: new StaticTransport(session),
    navigationSettlementTimeoutMs: 5000,
  });

  await manager.connect();
  const controller = new AbortController();
  const navPromise = manager.navigateAndWaitForLoadSettlement("https://chatgpt.com/", freshRoute, controller.signal);

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(navPromise, OperationAbortedError);
});

test("ordinary settlement failure becomes sanitized CdpNavigationFailedError", async () => {
  const runtime = createRuntime();
  const session = new FakeSettlementTransportSession();
  session.settlementFailure = new Error("SECRET_UNDERLYING_CDP_PAYLOAD");
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new StaticDiscovery(),
    transport: new StaticTransport(session),
  });

  await manager.connect();
  await assert.rejects(
    manager.navigateAndWaitForLoadSettlement("https://chatgpt.com/", freshRoute),
    (error: unknown) => {
      assert.ok(error instanceof CdpNavigationFailedError);
      assert.equal(error.code, "CDP_NAVIGATION_FAILED");
      assert.ok(!error.message.includes("SECRET_UNDERLYING_CDP_PAYLOAD"));
      return true;
    },
  );
});

test("runtime generation is revalidated after settlement completes", async () => {
  const runtime = createRuntime();
  const session = new FakeSettlementTransportSession();
  const gate = deferred<void>();
  session.block = gate;

  const manager = new CdpSessionManager(config, runtime, {
    discovery: new StaticDiscovery(),
    transport: new StaticTransport(session),
  });

  await manager.connect();
  const navPromise = manager.navigateAndWaitForLoadSettlement("https://chatgpt.com/", freshRoute);

  await new Promise((resolve) => setImmediate(resolve));
  // Mutate runtime generation while operation is in flight
  runtime.observe({ pid: 101, creationTime: "runtime-b" });
  gate.resolve();

  await assert.rejects(navPromise, RuntimeGenerationChangedError);
});
