import assert from "node:assert/strict";
import test from "node:test";
import { BoundCdpSessionManager } from "../../src/cdp/BoundCdpSessionManager.js";
import {
  CdpSessionManager,
  CdpTargetDiscoveryLike,
} from "../../src/cdp/CdpSessionManager.js";
import {
  CdpTransport,
  CdpTransportConnectOptions,
  CdpTransportSession,
} from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import {
  M2PublicCdpReadinessDiagnostic,
  M2PublicCdpReadinessDiagnosticEvent,
  wrapM2PublicCdpReadinessDiagnostics,
} from "../../src/diagnostics/M2PublicCdpReadinessDiagnostic.js";
import { RuntimeGenerationTracker, RuntimeLease } from "../../src/domain/RuntimeGeneration.js";
import { createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import { CdpReadinessFailedError } from "../../src/domain/errors.js";
import {
  ExistingReadinessSnapshot,
  RouteExpectation,
} from "../../src/readiness/types.js";
import { RuntimeProvenanceGuard } from "../../src/runtime/BoundRuntimeProvenanceGuard.js";

const config = { cdpHost: "127.0.0.1" as const, cdpPort: 9223 };
const target: CdpTargetInfo = {
  id: "same-target",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/same-target",
  url: "https://chatgpt.com/",
};
const readySnapshot: ExistingReadinessSnapshot = {
  mainFrame: { frameId: "main", loaderId: "loader", expectedRoute: true },
  eligibleEditables: [{ backendDOMNodeId: 101, focused: true }],
  backendActivity: { activeCount: 0, activityEpoch: 1 },
};

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function createRuntime(): RuntimeGenerationTracker {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 100, creationTime: "runtime-a" });
  return runtime;
}

class StaticDiscovery implements CdpTargetDiscoveryLike {
  public calls = 0;

  public async findPrimaryTarget(): Promise<CdpTargetInfo> {
    this.calls += 1;
    return target;
  }
}

class RepairSession implements CdpTransportSession {
  public readinessFailure: Error | null = null;
  public focusFailure: Error | null = null;
  public readinessSnapshot: ExistingReadinessSnapshot = readySnapshot;
  public initializeCalls = 0;
  public focusCalls = 0;
  private disconnectListener: (() => void) | null = null;

  public async close(): Promise<void> {}

  public onDisconnect(listener: () => void): () => void {
    this.disconnectListener = listener;
    return () => {
      if (this.disconnectListener === listener) {
        this.disconnectListener = null;
      }
    };
  }

  public disconnectNow(): void {
    this.disconnectListener?.();
  }

  public async initializeReadinessObservation(): Promise<void> {
    this.initializeCalls += 1;
  }

  public async navigate(_url: string, _signal?: AbortSignal): Promise<void> {}

  public async reload(_signal?: AbortSignal): Promise<void> {}

  public async getReadinessSnapshot(
    _expectedRoute: RouteExpectation,
  ): Promise<ExistingReadinessSnapshot> {
    if (this.readinessFailure !== null) {
      throw this.readinessFailure;
    }
    return this.readinessSnapshot;
  }

  public async focusBackendNode(
    _backendDOMNodeId: number,
    _signal?: AbortSignal,
  ): Promise<void> {
    this.focusCalls += 1;
    if (this.focusFailure !== null) {
      throw this.focusFailure;
    }
  }
}

class RepairTransport implements CdpTransport {
  public readonly sessions: RepairSession[] = [];
  public readonly targetIds: string[] = [];

  public async connect(options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    await options.beforeMutation?.(options.signal);
    this.targetIds.push(options.target.id);
    const session = new RepairSession();
    this.sessions.push(session);
    return session;
  }
}

class BlockingProvenanceGuard implements RuntimeProvenanceGuard {
  public bindCalls = 0;
  public assertCalls = 0;
  private nextBlock: { readonly entered: Deferred; readonly release: Deferred } | null = null;

  public blockNextAssert(): { readonly entered: Deferred; readonly release: Deferred } {
    assert.equal(this.nextBlock, null);
    const block = { entered: deferred(), release: deferred() };
    this.nextBlock = block;
    return block;
  }

  public async bind(_lease: RuntimeLease, _signal?: AbortSignal): Promise<void> {
    this.bindCalls += 1;
  }

  public async assertCurrent(_lease: RuntimeLease, _signal?: AbortSignal): Promise<void> {
    this.assertCalls += 1;
    const block = this.nextBlock;
    if (block === null) {
      return;
    }
    this.nextBlock = null;
    block.entered.resolve();
    await block.release.promise;
  }
}

function createBoundHarness(events: M2PublicCdpReadinessDiagnosticEvent[]) {
  const runtime = createRuntime();
  const discovery = new StaticDiscovery();
  const transport = new RepairTransport();
  const guard = new BlockingProvenanceGuard();
  const raw = new BoundCdpSessionManager(config, runtime, guard, {
    discovery,
    transport,
    attachTimeoutMs: 100,
    provenanceTimeoutMs: 1000,
  });
  const wrapped = wrapM2PublicCdpReadinessDiagnostics(
    raw,
    new M2PublicCdpReadinessDiagnostic((event) => events.push(event)),
  );
  return { runtime, discovery, transport, guard, wrapped };
}

test("BOUND genuine connected fast path remains REUSED_CONNECTED", async () => {
  const events: M2PublicCdpReadinessDiagnosticEvent[] = [];
  const { runtime, discovery, transport, wrapped } = createBoundHarness(events);
  const lease = runtime.getCurrentRuntimeLease();

  await wrapped.bindExistingRuntime(lease);
  assert.equal(transport.sessions.length, 1);
  assert.equal(discovery.calls, 1);

  await wrapped.connect();
  assert.equal(transport.sessions.length, 1);
  assert.equal(discovery.calls, 1);

  transport.sessions[0]!.readinessFailure = new Error("bounded snapshot detail");
  await assert.rejects(
    () => wrapped.getReadinessSnapshot({ kind: "FRESH_ROOT" }, lease),
    CdpReadinessFailedError,
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]!.prepareCdpMode, "REUSED_CONNECTED");
  assert.equal(transport.sessions[0]!.initializeCalls, 1);
});

test("BOUND same-generation disconnect during pre-connect provenance guard is RECONNECT_ATTEMPTED", async () => {
  const events: M2PublicCdpReadinessDiagnosticEvent[] = [];
  const { runtime, discovery, transport, guard, wrapped } = createBoundHarness(events);
  const lease = runtime.getCurrentRuntimeLease();

  await wrapped.bindExistingRuntime(lease);
  await wrapped.connect();
  const generationBefore = wrapped.boundGeneration;
  assert.equal(transport.sessions.length, 1);
  assert.equal(discovery.calls, 1);

  const blocked = guard.blockNextAssert();
  const reconnect = wrapped.connect();
  await blocked.entered.promise;

  transport.sessions[0]!.disconnectNow();
  assert.equal(wrapped.state, "DISCONNECTED");
  assert.equal(runtime.getCurrentRuntimeLease().generation, lease.generation);

  blocked.release.resolve();
  await reconnect;

  assert.equal(wrapped.state, "CONNECTED");
  assert.equal(wrapped.boundGeneration, generationBefore);
  assert.equal(transport.sessions.length, 2);
  assert.equal(discovery.calls, 2);
  assert.deepEqual(transport.targetIds, ["same-target", "same-target"]);
  assert.equal(transport.sessions[1]!.initializeCalls, 1);

  transport.sessions[1]!.readinessFailure = new Error("post-reconnect snapshot detail");
  await assert.rejects(
    () => wrapped.getReadinessSnapshot({ kind: "FRESH_ROOT" }, lease),
    CdpReadinessFailedError,
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]!.prepareCdpMode, "RECONNECT_ATTEMPTED");
  assert.notEqual(events[0]!.prepareCdpMode, "REUSED_CONNECTED");
});

test("FRESH focus attribution is keyed and cleared by unrelated or non-FRESH activity", async () => {
  const runtime = createRuntime();
  const discovery = new StaticDiscovery();
  const transport = new RepairTransport();
  const raw = new CdpSessionManager(config, runtime, {
    discovery,
    transport,
    attachTimeoutMs: 100,
  });
  const events: M2PublicCdpReadinessDiagnosticEvent[] = [];
  const wrapped = wrapM2PublicCdpReadinessDiagnostics(
    raw,
    new M2PublicCdpReadinessDiagnostic((event) => events.push(event)),
  );
  const lease = runtime.getCurrentRuntimeLease();

  await wrapped.connect();
  await wrapped.connect();
  const session = transport.sessions[0]!;
  session.focusFailure = new Error("focus detail must not enter diagnostic payload");

  await wrapped.getReadinessSnapshot({ kind: "FRESH_ROOT" }, lease);
  await assert.rejects(() => wrapped.focusBackendNode(202, lease), CdpReadinessFailedError);
  assert.deepEqual(events, []);

  await wrapped.getReadinessSnapshot({ kind: "FRESH_ROOT" }, lease);
  await wrapped.getReadinessSnapshot(
    {
      kind: "THREAD",
      locator: createConversationLocator("https://chatgpt.com/c/synthetic-thread"),
    },
    lease,
  );
  await assert.rejects(() => wrapped.focusBackendNode(101, lease), CdpReadinessFailedError);
  assert.deepEqual(events, []);

  await wrapped.getReadinessSnapshot({ kind: "FRESH_ROOT" }, lease);
  await assert.rejects(() => wrapped.focusBackendNode(101, lease), CdpReadinessFailedError);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.stage, "FRESH_READINESS_FOCUS");
  assert.equal(events[0]!.prepareCdpMode, "REUSED_CONNECTED");
  assert.doesNotMatch(JSON.stringify(events), /focus detail/);
});
