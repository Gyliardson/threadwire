import assert from "node:assert/strict";
import test from "node:test";
import { BoundCdpSessionManager } from "../../src/cdp/BoundCdpSessionManager.js";
import {
  CdpSessionManager,
  CdpTargetDiscoveryLike,
} from "../../src/cdp/CdpSessionManager.js";
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
  CdpAttachFailedError,
  CdpReadinessFailedError,
  OperationAbortedError,
  RuntimeGenerationChangedError,
  RuntimeProvenanceUnverifiedError,
} from "../../src/domain/errors.js";
import { RuntimeProvenanceGuard } from "../../src/runtime/BoundRuntimeProvenanceGuard.js";
import { delay } from "../../src/utils/timeout.js";

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

class ScriptedGuard implements RuntimeProvenanceGuard {
  public calls = 0;
  public bindCalls = 0;
  public observedAbort = false;
  public readonly events: string[];
  public onBind: ((signal?: AbortSignal) => Promise<void>) | null = null;
  public onAssert: ((call: number, signal?: AbortSignal) => Promise<void>) | null = null;

  public constructor(events: string[] = []) {
    this.events = events;
  }

  public async bind(_lease: RuntimeLease, signal?: AbortSignal): Promise<void> {
    this.bindCalls += 1;
    this.events.push("bind:start");
    try {
      await this.onBind?.(signal);
    } finally {
      this.events.push("bind:end");
    }
  }

  public async assertCurrent(_lease: RuntimeLease, signal?: AbortSignal): Promise<void> {
    this.calls += 1;
    const call = this.calls;
    this.events.push(`guard:${call}:start`);
    try {
      await this.onAssert?.(call, signal);
    } finally {
      this.events.push(`guard:${call}:end`);
    }
  }

  public hangUntilAbort(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((_resolve, reject) => {
      if (!signal) {
        reject(new Error("expected provenance operation signal"));
        return;
      }
      const onAbort = (): void => {
        this.observedAbort = true;
        reject(signal.reason ?? new Error("aborted"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
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
  public readinessDelayMs = 0;
  public navigateCalls = 0;
  public insertCalls = 0;
  public projectInsertCalls = 0;
  public projectCreateCalls = 0;
  public projectSendCalls = 0;
  public existingSendCalls = 0;
  public onReadiness: (() => void) | null = null;
  public onCompositeObservation: (() => void) | null = null;
  private disconnectListener: (() => void) | null = null;

  public constructor(
    private readonly beforeMutation?: CdpBeforeMutationHook,
    private readonly events: string[] = [],
  ) {}

  public async close(): Promise<void> {
    this.closes += 1;
    this.events.push("session:close");
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
    this.events.push("readiness:start");
    this.onReadiness?.();
    if (this.readinessDelayMs > 0) {
      await delay(this.readinessDelayMs);
    }
    this.events.push("readiness:end");
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
  public connectDelayMs = 0;
  public readinessDelayMs = 0;
  public observedAbort = false;
  public readonly sessions: FakeSession[] = [];
  public readonly events: string[];
  public onConnectStart: (() => void) | null = null;
  public onConnect: ((session: FakeSession) => void) | null = null;

  public constructor(events: string[] = []) {
    this.events = events;
  }

  public async connect(options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    this.calls += 1;
    this.events.push("transport:start");
    this.onConnectStart?.();
    const onAbort = (): void => {
      this.observedAbort = true;
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (this.connectDelayMs > 0) {
        await delay(this.connectDelayMs, options.signal);
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
    const session = new FakeSession(options.beforeMutation, this.events);
    session.readinessDelayMs = this.readinessDelayMs;
    this.sessions.push(session);
    this.onConnect?.(session);
    this.events.push("transport:return");
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

function scriptedFixture(options: {
  readonly attachTimeoutMs?: number;
  readonly provenanceTimeoutMs?: number;
  readonly events?: string[];
} = {}) {
  const runtime = new StaticRuntime();
  const events = options.events ?? [];
  const guard = new ScriptedGuard(events);
  const discovery = new FakeDiscovery();
  const transport = new FakeTransport(events);
  const manager = new BoundCdpSessionManager(config, runtime, guard, {
    discovery,
    transport,
    attachTimeoutMs: options.attachTimeoutMs ?? 100,
    provenanceTimeoutMs: options.provenanceTimeoutMs ?? 100,
  });
  return { runtime, guard, discovery, transport, manager, events };
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

test("T1 empirical regression keeps attach pre/post provenance outside the transport clock", async () => {
  const f = scriptedFixture({ attachTimeoutMs: 50, provenanceTimeoutMs: 100 });
  f.transport.connectDelayMs = 25;
  f.guard.onAssert = async (call, signal) => {
    if (call === 4) await delay(10, signal);
    if (call === 5) await delay(30, signal);
  };

  await f.manager.bindExistingRuntime(f.runtime.current);

  assert.equal(f.manager.state, "CONNECTED");
  assert.equal(f.transport.calls, 1);
  assert.equal(f.transport.sessions.length, 1);
});

test("T2 true inner transport timeout retains attach failure and abort semantics", async () => {
  const f = scriptedFixture({ attachTimeoutMs: 20, provenanceTimeoutMs: 100 });
  f.transport.connectDelayMs = 80;

  await assert.rejects(
    f.manager.bindExistingRuntime(f.runtime.current),
    (error: unknown) => error instanceof CdpAttachFailedError && error.code === "CDP_ATTACH_FAILED",
  );

  assert.equal(f.transport.observedAbort, true);
  assert.equal(f.transport.sessions.length, 0);
  assert.equal(f.manager.targetId, null);
});

test("T3 post-attach provenance failure closes the candidate before it can be stored", async () => {
  const f = scriptedFixture();
  f.guard.onAssert = async (call) => {
    if (call === 5) throw new RuntimeProvenanceUnverifiedError();
  };

  await assert.rejects(
    f.manager.bindExistingRuntime(f.runtime.current),
    RuntimeProvenanceUnverifiedError,
  );

  assert.equal(f.transport.sessions[0]?.closes, 1);
  assert.equal(f.manager.targetId, null);
  assert.equal(f.manager.state, "DISCONNECTED");
});

test("T4 pre-attach provenance failure prevents the inner transport call", async () => {
  const f = scriptedFixture();
  f.guard.onAssert = async (call) => {
    if (call === 4) throw new RuntimeProvenanceUnverifiedError();
  };

  await assert.rejects(
    f.manager.bindExistingRuntime(f.runtime.current),
    RuntimeProvenanceUnverifiedError,
  );
  assert.equal(f.transport.calls, 0);
});

test("T5 MANAGED keeps independent attach/readiness clocks and stable error mapping", async () => {
  const runtime = new StaticRuntime();
  const discovery = new FakeDiscovery();
  const transport = new FakeTransport();
  transport.connectDelayMs = 35;
  transport.readinessDelayMs = 35;
  const manager = new CdpSessionManager(config, runtime, {
    discovery,
    transport,
    attachTimeoutMs: 50,
  });

  await manager.connect();
  assert.equal(manager.state, "CONNECTED");
  assert.equal(transport.sessions[0]?.readinessCalls, 1);

  const timeoutTransport = new FakeTransport();
  timeoutTransport.connectDelayMs = 80;
  const timeoutManager = new CdpSessionManager(config, new StaticRuntime(), {
    discovery: new FakeDiscovery(),
    transport: timeoutTransport,
    attachTimeoutMs: 20,
  });
  await assert.rejects(
    timeoutManager.connect(),
    (error: unknown) => error instanceof CdpAttachFailedError && error.code === "CDP_ATTACH_FAILED",
  );

  const readinessTransport = new FakeTransport();
  readinessTransport.readinessDelayMs = 80;
  const readinessManager = new CdpSessionManager(config, new StaticRuntime(), {
    discovery: new FakeDiscovery(),
    transport: readinessTransport,
    attachTimeoutMs: 20,
  });
  await assert.rejects(
    readinessManager.connect(),
    (error: unknown) => error instanceof CdpReadinessFailedError && error.code === "CDP_READINESS_FAILED",
  );
});

test("T6 parent abort during inner attach propagates and no session escapes", async () => {
  const f = scriptedFixture({ attachTimeoutMs: 500, provenanceTimeoutMs: 100 });
  const started = deferred<void>();
  f.transport.connectDelayMs = 200;
  f.transport.onConnectStart = () => started.resolve();
  const controller = new AbortController();

  const connecting = f.manager.bindExistingRuntime(f.runtime.current, controller.signal);
  await started.promise;
  controller.abort(new Error("synthetic parent cancellation"));

  await assert.rejects(connecting, OperationAbortedError);
  assert.equal(f.transport.observedAbort, true);
  assert.equal(f.transport.sessions.length, 0);
  assert.equal(f.manager.targetId, null);
});

test("T7 readiness pre/post provenance has independent deadlines around the original readiness clock", async () => {
  const events: string[] = [];
  const f = scriptedFixture({ attachTimeoutMs: 50, provenanceTimeoutMs: 100, events });
  f.transport.readinessDelayMs = 25;
  f.guard.onAssert = async (call, signal) => {
    if (call === 6) await delay(10, signal);
    if (call === 7) await delay(30, signal);
  };

  await f.manager.bindExistingRuntime(f.runtime.current);

  assert.equal(f.manager.state, "CONNECTED");
  assert.ok(events.indexOf("guard:5:end") < events.indexOf("guard:6:start"));
  assert.ok(events.indexOf("guard:6:end") < events.indexOf("readiness:start"));
  assert.ok(events.indexOf("readiness:end") < events.indexOf("guard:7:start"));
});

test("T8 pre-attach hanging provenance aborts its child observer and fails closed", async () => {
  const f = scriptedFixture({ attachTimeoutMs: 100, provenanceTimeoutMs: 20 });
  f.guard.onAssert = async (call, signal) => {
    if (call === 4) await f.guard.hangUntilAbort(signal);
  };

  await assert.rejects(
    f.manager.bindExistingRuntime(f.runtime.current),
    (error: unknown) =>
      error instanceof RuntimeProvenanceUnverifiedError &&
      error.code === "RUNTIME_PROVENANCE_UNVERIFIED",
  );

  assert.equal(f.guard.observedAbort, true);
  assert.equal(f.transport.calls, 0);
  assert.equal(f.guard.calls, 4);
});

test("T8 post-attach hanging provenance closes the candidate and does not retry", async () => {
  const f = scriptedFixture({ attachTimeoutMs: 100, provenanceTimeoutMs: 20 });
  f.guard.onAssert = async (call, signal) => {
    if (call === 5) await f.guard.hangUntilAbort(signal);
  };

  await assert.rejects(
    f.manager.bindExistingRuntime(f.runtime.current),
    (error: unknown) =>
      error instanceof RuntimeProvenanceUnverifiedError &&
      error.code === "RUNTIME_PROVENANCE_UNVERIFIED",
  );

  assert.equal(f.guard.observedAbort, true);
  assert.equal(f.guard.calls, 5);
  assert.equal(f.transport.calls, 1);
  assert.equal(f.transport.sessions[0]?.closes, 1);
  assert.equal(f.manager.targetId, null);
});

test("bound admission bind itself uses the private provenance deadline", async () => {
  const f = scriptedFixture({ provenanceTimeoutMs: 20 });
  f.guard.onBind = async (signal) => await f.guard.hangUntilAbort(signal);

  await assert.rejects(
    f.manager.bindExistingRuntime(f.runtime.current),
    RuntimeProvenanceUnverifiedError,
  );
  assert.equal(f.guard.observedAbort, true);
  assert.equal(f.guard.bindCalls, 1);
  assert.equal(f.transport.calls, 0);
});

test("bounded raw mutation provenance timeout prevents the mutation", async () => {
  const f = scriptedFixture({ provenanceTimeoutMs: 20 });
  const admitted = f.runtime.current;
  await f.manager.bindExistingRuntime(admitted);
  const session = f.transport.sessions[0]!;
  const rawGuardCall = f.guard.calls + 2;
  f.guard.observedAbort = false;
  f.guard.onAssert = async (call, signal) => {
    if (call === rawGuardCall) await f.guard.hangUntilAbort(signal);
  };

  await assert.rejects(
    f.manager.insertText("synthetic", admitted),
    RuntimeProvenanceUnverifiedError,
  );
  assert.equal(f.guard.observedAbort, true);
  assert.equal(session.insertCalls, 0);
});

test("test helper constructs branded leases only through RuntimeGenerationTracker", () => {
  const first = lease();
  const second = lease(101, "2026-09-02T12:00:01.0000000Z");
  assert.equal(first.identity.pid, 100);
  assert.equal(second.identity.pid, 101);
});
