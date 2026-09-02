import assert from "node:assert/strict";
import test from "node:test";
import { BoundCdpSessionManager } from "../../src/cdp/BoundCdpSessionManager.js";
import { CdpSessionManager, CdpTargetDiscoveryLike } from "../../src/cdp/CdpSessionManager.js";
import {
  CdpTransport,
  CdpTransportConnectOptions,
  CdpTransportSession,
} from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { RuntimeGenerationTracker, RuntimeLease } from "../../src/domain/RuntimeGeneration.js";
import {
  CdpAttachFailedError,
  CdpReadinessFailedError,
  RuntimeProvenanceUnverifiedError,
} from "../../src/domain/errors.js";
import { ExistingReadinessSnapshot } from "../../src/readiness/types.js";
import { RuntimeProvenanceGuard } from "../../src/runtime/BoundRuntimeProvenanceGuard.js";

const managedConfig = { cdpHost: "127.0.0.1" as const, cdpPort: 9223 };
const boundConfig = { ...managedConfig, classicPolicy: "BOUND_EXISTING" as const };
const target: CdpTargetInfo = {
  id: "provenance-error-target",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/provenance-error-target",
  url: "https://chatgpt.com/",
};
const snapshot: ExistingReadinessSnapshot = {
  mainFrame: { frameId: "main", loaderId: "loader", expectedRoute: true },
  eligibleEditables: [],
  backendActivity: { activeCount: 0, activityEpoch: 0 },
};

function runtime(): RuntimeGenerationTracker {
  const tracker = new RuntimeGenerationTracker();
  tracker.observe({ pid: 100, creationTime: "2026-09-02T12:00:00.0000000Z" });
  return tracker;
}

class PhaseGuard implements RuntimeProvenanceGuard {
  public failed = false;

  public async bind(_lease: RuntimeLease, _signal?: AbortSignal): Promise<void> {
    if (this.failed) throw new RuntimeProvenanceUnverifiedError();
  }

  public async assertCurrent(_lease: RuntimeLease, _signal?: AbortSignal): Promise<void> {
    if (this.failed) throw new RuntimeProvenanceUnverifiedError();
  }
}

class PhaseDiscovery implements CdpTargetDiscoveryLike {
  public afterFind: (() => void) | null = null;

  public async findPrimaryTarget(): Promise<CdpTargetInfo> {
    this.afterFind?.();
    return target;
  }
}

class PhaseSession implements CdpTransportSession {
  public closeCalls = 0;
  public onInitialize: (() => void) | null = null;
  public initializationFailure: Error | null = null;
  private disconnectListener: (() => void) | null = null;

  public async close(): Promise<void> {
    this.closeCalls += 1;
  }

  public onDisconnect(listener: () => void): () => void {
    this.disconnectListener = listener;
    return () => {
      if (this.disconnectListener === listener) this.disconnectListener = null;
    };
  }

  public disconnectNow(): void {
    this.disconnectListener?.();
  }

  public async initializeReadinessObservation(): Promise<void> {
    this.onInitialize?.();
    if (this.initializationFailure) throw this.initializationFailure;
  }

  public async navigate(_url: string, _signal?: AbortSignal): Promise<void> {}
  public async reload(_signal?: AbortSignal): Promise<void> {}
  public async getReadinessSnapshot(): Promise<ExistingReadinessSnapshot> {
    return snapshot;
  }
  public async focusBackendNode(_backendDOMNodeId: number, _signal?: AbortSignal): Promise<void> {}
}

class PhaseTransport implements CdpTransport {
  public calls = 0;
  public readonly sessions: PhaseSession[] = [];
  public afterCreate: ((session: PhaseSession) => void) | null = null;
  public failAttach = false;

  public async connect(_options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    this.calls += 1;
    if (this.failAttach) throw new Error("synthetic ordinary attach failure");
    const session = new PhaseSession();
    this.sessions.push(session);
    this.afterCreate?.(session);
    return session;
  }
}

function boundFixture() {
  const tracker = runtime();
  const guard = new PhaseGuard();
  const discovery = new PhaseDiscovery();
  const transport = new PhaseTransport();
  const manager = new BoundCdpSessionManager(boundConfig, tracker, guard, {
    discovery,
    transport,
    attachTimeoutMs: 100,
  });
  return {
    tracker,
    lease: tracker.getCurrentRuntimeLease(),
    guard,
    discovery,
    transport,
    manager,
  };
}

test("BOUND provenance failure after target discovery remains authoritative", async () => {
  const f = boundFixture();
  f.discovery.afterFind = () => {
    f.guard.failed = true;
  };

  await assert.rejects(
    f.manager.bindExistingRuntime(f.lease),
    RuntimeProvenanceUnverifiedError,
  );
  assert.equal(f.transport.calls, 0);
});

test("BOUND provenance failure after attach closes partial session and remains authoritative", async () => {
  const f = boundFixture();
  f.transport.afterCreate = () => {
    f.guard.failed = true;
  };

  await assert.rejects(
    f.manager.bindExistingRuntime(f.lease),
    RuntimeProvenanceUnverifiedError,
  );
  assert.equal(f.transport.sessions[0]?.closeCalls, 1);
});

test("BOUND provenance failure during readiness closes partial session and remains authoritative", async () => {
  const f = boundFixture();
  f.transport.afterCreate = (session) => {
    session.onInitialize = () => {
      f.guard.failed = true;
    };
  };

  await assert.rejects(
    f.manager.bindExistingRuntime(f.lease),
    RuntimeProvenanceUnverifiedError,
  );
  assert.ok((f.transport.sessions[0]?.closeCalls ?? 0) >= 1);
});

test("BOUND reconnect provenance failure is not converted to an attach error", async () => {
  const f = boundFixture();
  await f.manager.bindExistingRuntime(f.lease);
  f.transport.sessions[0]!.disconnectNow();
  f.guard.failed = true;

  await assert.rejects(f.manager.connect(), RuntimeProvenanceUnverifiedError);
  assert.equal(f.transport.calls, 1);
});

test("MANAGED ordinary transport attach failure remains CdpAttachFailedError", async () => {
  const tracker = runtime();
  const transport = new PhaseTransport();
  transport.failAttach = true;
  const manager = new CdpSessionManager(managedConfig, tracker, {
    discovery: new PhaseDiscovery(),
    transport,
    attachTimeoutMs: 100,
  });

  await assert.rejects(manager.connect(), CdpAttachFailedError);
});

test("MANAGED ordinary readiness failure remains CdpReadinessFailedError and closes partial session", async () => {
  const tracker = runtime();
  const transport = new PhaseTransport();
  transport.afterCreate = (session) => {
    session.initializationFailure = new Error("synthetic ordinary readiness failure");
  };
  const manager = new CdpSessionManager(managedConfig, tracker, {
    discovery: new PhaseDiscovery(),
    transport,
    attachTimeoutMs: 100,
  });

  await assert.rejects(manager.connect(), CdpReadinessFailedError);
  assert.equal(transport.sessions[0]?.closeCalls, 1);
});
