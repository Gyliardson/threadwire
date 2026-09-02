import assert from "node:assert/strict";
import test from "node:test";
import { BoundCdpSessionManager } from "../../src/cdp/BoundCdpSessionManager.js";
import { CdpTargetDiscoveryLike } from "../../src/cdp/CdpSessionManager.js";
import {
  CdpBeforeMutationHook,
  CdpTransport,
  CdpTransportConnectOptions,
  CdpTransportSession,
  CdpTurnObservationHandle,
} from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { createProjectLocator, createProjectName } from "../../src/domain/ProjectIdentity.js";
import {
  RuntimeGenerationTracker,
  RuntimeIdentity,
  RuntimeLease,
  RuntimeLeaseSource,
  sameRuntimeLease,
} from "../../src/domain/RuntimeGeneration.js";
import { createConversationLocator } from "../../src/domain/ThreadIdentity.js";
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
const INITIAL_IDENTITY: RuntimeIdentity = {
  pid: 100,
  creationTime: "2026-09-02T12:00:00.0000000Z",
};
const PROJECT_LOCATOR = createProjectLocator(
  "https://chatgpt.com/g/g-p-00000000000000000000000000000002/project",
);
const CONVERSATION_LOCATOR = createConversationLocator("https://chatgpt.com/c/synthetic-thread");

function lease(pid = INITIAL_IDENTITY.pid, creationTime = INITIAL_IDENTITY.creationTime): RuntimeLease {
  const tracker = new RuntimeGenerationTracker();
  tracker.observe({ pid, creationTime });
  return tracker.getCurrentRuntimeLease();
}

class StaticRuntime implements RuntimeLeaseSource {
  private readonly tracker = new RuntimeGenerationTracker();

  public constructor() {
    this.tracker.observe(INITIAL_IDENTITY);
  }

  public get current(): RuntimeLease {
    return this.tracker.getCurrentRuntimeLease();
  }

  public replace(identity: RuntimeIdentity): RuntimeLease {
    this.tracker.observe(identity);
    return this.tracker.getCurrentRuntimeLease();
  }

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
  public bindCalls = 0;

  public async bind(): Promise<void> {
    this.bindCalls += 1;
    if (this.failed) throw new RuntimeProvenanceUnverifiedError();
  }

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
  public projectInsertCalls = 0;
  public projectCreateCalls = 0;
  public projectSendCalls = 0;
  public existingSendCalls = 0;
  public onReadiness: (() => void) | null = null;
  public onCompositeObservation: (() => void) | null = null;
  private disconnectListener: (() => void) | null = null;

  public constructor(private readonly beforeMutation?: CdpBeforeMutationHook) {}

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
    await this.beforeMutation?.();
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
    await this.beforeMutation?.();
    this.insertCalls += 1;
  }
  public async insertTextIntoProjectComposer(
    _text: string,
    _projectLocator: typeof PROJECT_LOCATOR,
    _backendDOMNodeId: number,
    signal?: AbortSignal,
  ): Promise<number> {
    await Promise.resolve();
    this.onCompositeObservation?.();
    await this.beforeMutation?.(signal);
    this.projectInsertCalls += 1;
    return 601;
  }
  public async dispatchEnterKeyDown(): Promise<void> {}
  public async dispatchEnterKeyUp(): Promise<void> {}
  public async clickTurnSendButton(
    _projectLocator: typeof PROJECT_LOCATOR,
    _backendDOMNodeId: number,
    _formBackendDOMNodeId: number,
    _expectedText: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await Promise.resolve();
    this.onCompositeObservation?.();
    await this.beforeMutation?.(signal);
    this.projectSendCalls += 1;
  }
  public async clickExistingTurnSendButton(
    _conversationLocator: typeof CONVERSATION_LOCATOR,
    _backendDOMNodeId: number,
    _expectedText: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await Promise.resolve();
    this.onCompositeObservation?.();
    await this.beforeMutation?.(signal);
    this.existingSendCalls += 1;
  }
  public async getCurrentConversationLocator(): Promise<null> {
    return null;
  }
  public async createProjectThroughUi(
    _name: ReturnType<typeof createProjectName>,
    signal?: AbortSignal,
  ): Promise<typeof PROJECT_LOCATOR> {
    await Promise.resolve();
    this.onCompositeObservation?.();
    await this.beforeMutation?.(signal);
    this.projectCreateCalls += 1;
    return PROJECT_LOCATOR;
  }
}

class FakeTransport implements CdpTransport {
  public calls = 0;
  public readonly sessions: FakeSession[] = [];
  public onConnect: ((session: FakeSession) => void) | null = null;

  public async connect(options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    this.calls += 1;
    const session = new FakeSession(options.beforeMutation);
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

test("bound CDP explicitly binds provenance once before initial connection", async () => {
  const f = fixture();
  await f.manager.bindExistingRuntime(f.runtime.current);
  assert.equal(f.guard.bindCalls, 1);
  assert.ok(f.guard.calls > 0);
});

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

test("bound CDP reconnect keeps both immutable runtime and listener admission bindings", async () => {
  const f = fixture();
  const admitted = f.runtime.current;
  await f.manager.bindExistingRuntime(admitted);
  f.transport.sessions[0]!.disconnectNow();

  await f.manager.connect();

  assert.equal(f.transport.calls, 2);
  assert.equal(f.guard.bindCalls, 1);
  await f.manager.assertBoundRuntimeCurrent(admitted);
});

test("bound CDP retains the immutable lease after disconnect and rejects replacement provenance", async () => {
  const f = fixture();
  const admitted = f.runtime.current;
  await f.manager.bindExistingRuntime(admitted);
  f.transport.sessions[0]!.disconnectNow();
  const replacement = f.runtime.replace({
    pid: 200,
    creationTime: "2026-09-02T12:00:01.0000000Z",
  });
  f.guard.failed = true;

  await assert.rejects(f.manager.connect(), RuntimeProvenanceUnverifiedError);
  assert.equal(f.transport.calls, 1);
  await assert.rejects(
    f.manager.bindExistingRuntime(replacement),
    RuntimeGenerationChangedError,
  );
  assert.equal(f.guard.bindCalls, 1);
});

test("bound CDP verifies provenance immediately before route and primitive turn mutation", async () => {
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

test("bound CDP raw pre-mutation hook blocks Project composer insertion after async observation", async () => {
  const f = fixture();
  const admitted = f.runtime.current;
  await f.manager.bindExistingRuntime(admitted);
  const session = f.transport.sessions[0]!;
  session.onCompositeObservation = () => {
    f.guard.failed = true;
  };

  await assert.rejects(
    f.manager.insertTextIntoProjectComposer("synthetic", PROJECT_LOCATOR, 501, admitted),
    RuntimeProvenanceUnverifiedError,
  );
  assert.equal(session.projectInsertCalls, 0);
});

test("bound CDP raw pre-mutation hook blocks Project creation after async observation", async () => {
  const f = fixture();
  const admitted = f.runtime.current;
  await f.manager.bindExistingRuntime(admitted);
  const session = f.transport.sessions[0]!;
  session.onCompositeObservation = () => {
    f.guard.failed = true;
  };

  await assert.rejects(
    f.manager.createProjectThroughUi(createProjectName("Synthetic"), admitted),
    RuntimeProvenanceUnverifiedError,
  );
  assert.equal(session.projectCreateCalls, 0);
});

test("bound CDP raw pre-mutation hook blocks Project and existing send after async observation", async () => {
  for (const kind of ["project", "existing"] as const) {
    const f = fixture();
    const admitted = f.runtime.current;
    await f.manager.bindExistingRuntime(admitted);
    const session = f.transport.sessions[0]!;
    session.onCompositeObservation = () => {
      f.guard.failed = true;
    };

    if (kind === "project") {
      await assert.rejects(
        f.manager.clickTurnSendButton(PROJECT_LOCATOR, 501, 601, "synthetic", admitted),
        RuntimeProvenanceUnverifiedError,
      );
      assert.equal(session.projectSendCalls, 0);
    } else {
      await assert.rejects(
        f.manager.clickExistingTurnSendButton(CONVERSATION_LOCATOR, 501, "synthetic", admitted),
        RuntimeProvenanceUnverifiedError,
      );
      assert.equal(session.existingSendCalls, 0);
    }
  }
});

test("test helper constructs branded leases only through RuntimeGenerationTracker", () => {
  const first = lease();
  const second = lease(101, "2026-09-02T12:00:01.0000000Z");
  assert.equal(first.identity.pid, 100);
  assert.equal(second.identity.pid, 101);
});
