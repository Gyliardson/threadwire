import assert from "node:assert/strict";
import test from "node:test";
import { BoundCdpSessionManager } from "../../src/cdp/BoundCdpSessionManager.js";
import { CdpTargetDiscoveryLike } from "../../src/cdp/CdpSessionManager.js";
import {
  CdpTransport,
  CdpTransportConnectOptions,
  CdpTransportSession,
  CdpTurnObservationHandle,
} from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import {
  RuntimeGeneration,
  RuntimeLease,
  RuntimeLeaseSource,
  sameRuntimeLease,
} from "../../src/domain/RuntimeGeneration.js";
import {
  RuntimeGenerationChangedError,
  RuntimeProvenanceUnverifiedError,
} from "../../src/domain/errors.js";
import { RuntimeProvenanceGuard } from "../../src/runtime/BoundRuntimeProvenanceGuard.js";

const config = {
  cdpHost: "127.0.0.1" as const,
  cdpPort: 9223,
  classicPolicy: "BOUND_EXISTING" as const,
};
const target: CdpTargetInfo = {
  id: "synthetic-target",
  title: "ChatGPT",
  type: "page",
  description: "",
  url: "https://chatgpt.com/",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/synthetic-target",
};

function lease(
  pid = 100,
  creationTime = "2026-09-02T12:00:00.0000000Z",
): RuntimeLease {
  return Object.freeze({
    generation: 1 as RuntimeGeneration,
    identity: Object.freeze({ pid, creationTime }),
  });
}

class StaticRuntime implements RuntimeLeaseSource {
  public current = lease();

  public getCurrentRuntimeLease(): RuntimeLease {
    return this.current;
  }

  public assertRuntimeLeaseCurrent(expected: RuntimeLease): void {
    if (!sameRuntimeLease(this.current, expected)) throw new RuntimeGenerationChangedError();
  }
}

class ToggleGuard implements RuntimeProvenanceGuard {
  public failed = false;
  public failAtCall: number | null = null;
  public calls = 0;

  public async assertCurrent(): Promise<void> {
    this.calls += 1;
    if (this.failed || this.failAtCall === this.calls) {
      throw new RuntimeProvenanceUnverifiedError();
    }
  }
}

class FakeDiscovery implements CdpTargetDiscoveryLike {
  public calls = 0;
  public onFind: (() => void) | null = null;

  public async findPrimaryTarget(): Promise<CdpTargetInfo> {
    this.calls += 1;
    this.onFind?.();
    return target;
  }
}

class FakeSession implements CdpTransportSession {
  public closes = 0;
  public readinessCalls = 0;
  public navigateCalls = 0;
  public insertCalls = 0;
  public onReadiness: (() => void) | null = null;
  private disconnectListener: (() => void) | null = null;

  public async close(): Promise<void> {
    this.closes += 1;
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
    this.readinessCalls += 1;
    this.onReadiness?.();
  }

  public async navigate(): Promise<void> {
    this.navigateCalls += 1;
  }

  public async reload(): Promise<void> {}
  public async getReadinessSnapshot(): Promise<never> {
    throw new Error("unused");
  }
  public async focusBackendNode(): Promise<void> {}
  public async getTurnComposerState() {
    return { expectedRoute: true, eligible: true, focused: true, empty: true };
  }
  public armTurnObservation(): CdpTurnObservationHandle {
    return {} as CdpTurnObservationHandle;
  }
  public getTurnObservation() {
    return { prepareCount: 0, write: null };
  }
  public releaseTurnObservation(): void {}
  public async insertText(): Promise<void> {
    this.insertCalls += 1;
  }
  public async dispatchEnterKeyDown(): Promise<void> {}
  public async dispatchEnterKeyUp(): Promise<void> {}
  public async getCurrentConversationLocator(): Promise<null> {
    return null;
  }
}

class FakeTransport implements CdpTransport {
  public calls = 0;
  public readonly sessions: FakeSession[] = [];
  public onConnect: ((session: FakeSession) => void) | null = null;

  public async connect(_options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    this.calls += 1;
    const session = new FakeSession();
    this.sessions.push(session);
    this.onConnect?.(session);
    return session;
  }
}

function fixture() {
  const runtime = new StaticRuntime();
  const guard = new ToggleGuard();
  const discovery = new FakeDiscovery();
  const transport = new FakeTransport();
  const manager = new BoundCdpSessionManager(config, runtime, guard, {
    discovery,
    transport,
    attachTimeoutMs: 100,
  });
  return { runtime, guard, discovery, transport, manager };
}

test("bound CDP rejects provenance change during target discovery", async () => {
  const f = fixture();
  f.discovery.onFind = () => {
    f.guard.failed = true;
  };

  await assert.rejects(
    f.manager.bindExistingRuntime(f.runtime.current),
    RuntimeProvenanceUnverifiedError,
  );
  assert.equal(f.transport.calls, 0);
});

test("bound CDP rejects provenance change during attach and closes the partial session", async () => {
  const f = fixture();
  f.transport.onConnect = () => {
    f.guard.failed = true;
  };

  await assert.rejects(f.manager.bindExistingRuntime(f.runtime.current));
  assert.equal(f.transport.sessions[0]?.closes, 1);
});

test("bound CDP rejects provenance change during readiness and closes the partial session", async () => {
  const f = fixture();
  f.transport.onConnect = (session) => {
    session.onReadiness = () => {
      f.guard.failed = true;
    };
  };

  await assert.rejects(f.manager.bindExistingRuntime(f.runtime.current));
  assert.ok((f.transport.sessions[0]?.closes ?? 0) >= 1);
});

test("bound CDP closes an attached session when the final post-connect provenance guard fails", async () => {
  const f = fixture();
  f.transport.onConnect = (session) => {
    session.onReadiness = () => {
      // The readiness wrapper still has one required post-readiness proof. The next
      // guard after that is BoundCdpSessionManager's final post-connect proof.
      f.guard.failAtCall = f.guard.calls + 2;
    };
  };

  await assert.rejects(
    f.manager.bindExistingRuntime(f.runtime.current),
    RuntimeProvenanceUnverifiedError,
  );

  assert.ok((f.transport.sessions[0]?.closes ?? 0) >= 1);
  assert.equal(f.manager.state, "DISCONNECTED");
});

test("bound CDP reconnects only while the same immutable runtime provenance remains valid", async () => {
  const f = fixture();
  const admitted = f.runtime.current;
  await f.manager.bindExistingRuntime(admitted);
  f.transport.sessions[0]!.disconnectNow();

  await f.manager.connect();

  assert.equal(f.transport.calls, 2);
  await f.manager.assertBoundRuntimeCurrent(admitted);
});

test("bound CDP retains the immutable lease after disconnect and rejects replacement provenance", async () => {
  const f = fixture();
  const admitted = f.runtime.current;
  await f.manager.bindExistingRuntime(admitted);
  f.transport.sessions[0]!.disconnectNow();
  f.runtime.current = lease(200, "2026-09-02T12:00:01.0000000Z");
  f.guard.failed = true;

  await assert.rejects(f.manager.connect(), RuntimeProvenanceUnverifiedError);
  assert.equal(f.transport.calls, 1);
  await assert.rejects(
    f.manager.bindExistingRuntime(f.runtime.current),
    RuntimeGenerationChangedError,
  );
});

test("bound CDP verifies provenance immediately before route and turn mutation", async () => {
  const f = fixture();
  const admitted = f.runtime.current;
  await f.manager.bindExistingRuntime(admitted);
  const session = f.transport.sessions[0]!;
  f.guard.failed = true;

  await assert.rejects(
    f.manager.navigate("https://chatgpt.com/"),
    RuntimeProvenanceUnverifiedError,
  );
  await assert.rejects(
    f.manager.insertText("synthetic", admitted),
    RuntimeProvenanceUnverifiedError,
  );
  assert.equal(session.navigateCalls, 0);
  assert.equal(session.insertCalls, 0);
});
