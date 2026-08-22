import assert from "node:assert/strict";
import test from "node:test";
import { ChromeRemoteInterfaceTransport } from "../../src/cdp/ChromeRemoteInterfaceTransport.js";
import {
  CdpTurnComposerState,
  CdpTurnObservationHandle,
  CdpTurnObservationSnapshot,
  CdpTurnTransportSession,
} from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import {
  RuntimeGenerationTracker,
  RuntimeLease,
} from "../../src/domain/RuntimeGeneration.js";
import {
  CdpDisconnectedError,
  OperationAbortedError,
  TurnStateUncertainError,
} from "../../src/domain/errors.js";
import {
  ConversationLocator,
  createConversationLocator,
} from "../../src/domain/ThreadIdentity.js";
import { ExistingReadinessPolicy } from "../../src/readiness/ExistingReadinessPolicy.js";
import { FreshReadinessPolicy } from "../../src/readiness/FreshReadinessPolicy.js";
import { ReadinessController } from "../../src/readiness/ReadinessController.js";
import {
  ExistingReadinessObservationPort,
  ExistingReadinessSnapshot,
  RouteExpectation,
} from "../../src/readiness/types.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";
import { ThreadRegistry } from "../../src/routing/ThreadRegistry.js";
import { TurnExecutor } from "../../src/turn/TurnExecutor.js";
import {
  TurnCdpPort,
  TurnComposerPreflightPort,
} from "../../src/turn/types.js";

function createRuntime(): RuntimeGenerationTracker {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 100, creationTime: "runtime-a" });
  return runtime;
}

const observationHandle = Object.freeze({}) as unknown as CdpTurnObservationHandle;

function writeObservation(lifecycle: "ACTIVE" | "FINISHED" | "FAILED"): CdpTurnObservationSnapshot {
  return Object.freeze({
    prepareCount: 0,
    write: Object.freeze({ lifecycle }),
  });
}

class NoopPreflight implements TurnComposerPreflightPort {
  public async waitForTurnComposer(
    _expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<void> {}
}

class ScriptedTurnCdp implements TurnCdpPort {
  public readonly events: string[] = [];
  public snapshots: readonly CdpTurnObservationSnapshot[] = [writeObservation("FINISHED")];
  public locator: ConversationLocator | null = null;
  public insertHook: (() => void) | null = null;
  public keyDownError: Error | null = null;
  public keyUpError: Error | null = null;
  public keyDownNeverSettles = false;
  public observationError: Error | null = null;
  private snapshotIndex = 0;
  private submitted = false;

  public constructor(private readonly runtime: RuntimeGenerationTracker) {}

  public async getTurnComposerState(
    _expectedRoute: RouteExpectation,
    lease: RuntimeLease,
  ): Promise<CdpTurnComposerState> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    return Object.freeze({ expectedRoute: true, eligible: true, focused: true, empty: true });
  }

  public armTurnObservation(lease: RuntimeLease): CdpTurnObservationHandle {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.events.push("arm");
    return observationHandle;
  }

  public getTurnObservation(
    _handle: CdpTurnObservationHandle,
    lease: RuntimeLease,
  ): CdpTurnObservationSnapshot {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    if (this.observationError) {
      throw this.observationError;
    }
    if (!this.submitted) {
      return Object.freeze({ prepareCount: 0, write: null });
    }
    const snapshot =
      this.snapshots[this.snapshotIndex] ??
      this.snapshots[this.snapshots.length - 1] ??
      writeObservation("FINISHED");
    this.snapshotIndex += 1;
    return snapshot;
  }

  public releaseTurnObservation(_handle: CdpTurnObservationHandle): void {
    this.events.push("release");
  }

  public async insertText(_text: string, lease: RuntimeLease): Promise<void> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.events.push("insert");
    this.insertHook?.();
  }

  public async dispatchEnterKeyDown(lease: RuntimeLease): Promise<void> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.events.push("down");
    this.submitted = true;
    if (this.keyDownNeverSettles) {
      await new Promise<void>(() => undefined);
      return;
    }
    if (this.keyDownError) {
      throw this.keyDownError;
    }
  }

  public async dispatchEnterKeyUp(lease: RuntimeLease): Promise<void> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.events.push("up");
    if (this.keyUpError) {
      throw this.keyUpError;
    }
  }

  public async getCurrentConversationLocator(
    lease: RuntimeLease,
  ): Promise<ConversationLocator | null> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    return this.locator;
  }
}

function scriptedFixture(options: { commandTimeoutMs?: number } = {}) {
  const runtime = createRuntime();
  const scheduler = new OperationScheduler(runtime);
  let handleIndex = 0;
  const registry = new ThreadRegistry({ handleFactory: () => `correction_${++handleIndex}` });
  const existingLocator = createConversationLocator("https://chatgpt.com/c/m5-correction-existing");
  const existingHandle = registry.register(existingLocator);
  const cdp = new ScriptedTurnCdp(runtime);
  const executor = new TurnExecutor(
    registry,
    scheduler,
    new NoopPreflight(),
    cdp,
    {
      commandTimeoutMs: options.commandTimeoutMs ?? 50,
      writeObservationTimeoutMs: 5,
      writeSettlementTimeoutMs: 5,
      freshConversationTimeoutMs: 5,
      pollIntervalMs: 1,
      sleep: async () => undefined,
    },
  );
  return { runtime, scheduler, registry, existingLocator, existingHandle, cdp, executor };
}

test("abort after successful composition but before Enter remains pre-submit", async () => {
  const f = scriptedFixture();
  const abort = new AbortController();
  f.cdp.insertHook = () => abort.abort(new Error("cancel after composition"));

  await assert.rejects(
    () =>
      f.executor.execute(
        { kind: "THREAD", threadHandle: f.existingHandle },
        "synthetic prompt",
        abort.signal,
      ),
    OperationAbortedError,
  );

  assert.deepEqual(f.cdp.events, ["arm", "insert", "release"]);
  let routeRan = false;
  await f.scheduler.schedule("ROUTE", async () => {
    routeRan = true;
  });
  assert.equal(routeRan, true, "composition-only cancellation must not invent an active network write");
});

test("generic keyDown rejection is superseded by a proven legitimate FINISHED write", async () => {
  const f = scriptedFixture();
  f.cdp.keyDownError = new Error("synthetic ordinary keyDown failure");

  const result = await f.executor.execute(
    { kind: "THREAD", threadHandle: f.existingHandle },
    "synthetic prompt",
  );

  assert.deepEqual(result, {
    kind: "THREAD",
    threadHandle: f.existingHandle,
    created: false,
  });
  assert.equal(f.cdp.events.includes("up"), false);
});

test("generic keyUp rejection is superseded by a proven legitimate FINISHED write", async () => {
  const f = scriptedFixture();
  f.cdp.keyUpError = new Error("synthetic ordinary keyUp failure");

  const result = await f.executor.execute(
    { kind: "THREAD", threadHandle: f.existingHandle },
    "synthetic prompt",
  );

  assert.equal(result.created, false);
  assert.ok(f.cdp.events.includes("down"));
  assert.ok(f.cdp.events.includes("up"));
});

test("fresh turn still registers a new handle after generic keyDown failure when write and route are proven", async () => {
  const f = scriptedFixture();
  const freshLocator = createConversationLocator("https://chatgpt.com/c/m5-correction-fresh");
  f.cdp.locator = freshLocator;
  f.cdp.keyDownError = new Error("synthetic ordinary keyDown failure");

  const result = await f.executor.execute({ kind: "FRESH" }, "synthetic prompt");

  assert.equal(result.created, true);
  assert.equal(f.registry.resolve(result.threadHandle), freshLocator);
});

test("post-submit disconnect retains fail-closed precedence over any possible write success", async () => {
  const f = scriptedFixture();
  f.cdp.keyDownError = new CdpDisconnectedError();

  await assert.rejects(
    () => f.executor.execute({ kind: "THREAD", threadHandle: f.existingHandle }, "synthetic prompt"),
    TurnStateUncertainError,
  );

  await assert.rejects(
    () => f.scheduler.schedule("ROUTE", async () => undefined),
    TurnStateUncertainError,
  );
});

test("post-submit keyDown timeout retains fail-closed precedence", async () => {
  const f = scriptedFixture({ commandTimeoutMs: 2 });
  f.cdp.keyDownNeverSettles = true;

  await assert.rejects(
    () => f.executor.execute({ kind: "THREAD", threadHandle: f.existingHandle }, "synthetic prompt"),
    TurnStateUncertainError,
  );

  await assert.rejects(
    () => f.scheduler.schedule("TURN", async () => undefined),
    TurnStateUncertainError,
  );
});

test("fresh result does not claim creation when the resulting locator was already registered", async () => {
  const f = scriptedFixture();
  f.cdp.locator = f.existingLocator;

  const result = await f.executor.execute({ kind: "FRESH" }, "synthetic prompt");

  assert.deepEqual(result, {
    kind: "THREAD",
    threadHandle: f.existingHandle,
    created: false,
  });
});

test("ThreadRegistry registration status distinguishes new and known locators without exposing locator data", () => {
  let handleIndex = 0;
  const registry = new ThreadRegistry({ handleFactory: () => `registration_${++handleIndex}` });
  const locator = createConversationLocator("https://chatgpt.com/c/m5-registration-status");

  const first = registry.registerWithStatus(locator);
  const second = registry.registerWithStatus(locator);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.threadHandle, first.threadHandle);
  assert.equal(JSON.stringify(second).includes("m5-registration-status"), false);
});

class MutableReadinessObservation implements ExistingReadinessObservationPort {
  public backendDOMNodeId = 101;
  public mismatchRootOnce = false;

  public async getReadinessSnapshot(
    _expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<ExistingReadinessSnapshot> {
    const expectedRoute = !this.mismatchRootOnce;
    this.mismatchRootOnce = false;
    return Object.freeze({
      mainFrame: Object.freeze({
        frameId: "main",
        loaderId: "stable-loader",
        expectedRoute,
      }),
      eligibleEditables: Object.freeze([
        Object.freeze({ backendDOMNodeId: this.backendDOMNodeId, focused: true }),
      ]),
      backendActivity: Object.freeze({ activeCount: 0, activityEpoch: 1 }),
    });
  }

  public async focusBackendNode(
    _backendDOMNodeId: number,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<void> {}
}

function freshProofFixture() {
  const runtime = createRuntime();
  const observation = new MutableReadinessObservation();
  let freshClockCalls = 0;
  const controller = new ReadinessController(
    observation,
    new ExistingReadinessPolicy({ frameStableObservations: 1, focusStableObservations: 1 }),
    new FreshReadinessPolicy({
      frameStableObservations: 1,
      focusStableObservations: 1,
      guardDurationMs: 0,
      clock: () => {
        freshClockCalls += 1;
        return freshClockCalls;
      },
    }),
    {
      timeoutMs: 100,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    },
  );
  return {
    runtime,
    observation,
    controller,
    freshClockCalls: () => freshClockCalls,
  };
}

test("fresh proof is reusable once only for the exact composer backend node", async () => {
  const f = freshProofFixture();
  const lease = f.runtime.getCurrentRuntimeLease();

  await f.controller.waitForFreshRoute(lease);
  assert.equal(f.freshClockCalls(), 1);

  await f.controller.waitForTurnComposer({ kind: "FRESH_ROOT" }, lease);
  assert.equal(f.freshClockCalls(), 1, "same composer may consume the M4 proof once");

  await f.controller.waitForTurnComposer({ kind: "FRESH_ROOT" }, lease);
  assert.equal(f.freshClockCalls(), 2, "consumed proof cannot be reused a second time");
});

test("same frame and loader with a different composer backend node cannot reuse fresh proof", async () => {
  const f = freshProofFixture();
  const lease = f.runtime.getCurrentRuntimeLease();

  await f.controller.waitForFreshRoute(lease);
  f.observation.backendDOMNodeId = 202;
  await f.controller.waitForTurnComposer({ kind: "FRESH_ROOT" }, lease);

  assert.equal(f.freshClockCalls(), 2, "replacement composer must execute FreshReadinessPolicy again");
});

test("old-generation fresh proof cannot be reused even for the same composer", async () => {
  const f = freshProofFixture();
  const oldLease = f.runtime.getCurrentRuntimeLease();

  await f.controller.waitForFreshRoute(oldLease);
  f.runtime.observe({ pid: 200, creationTime: "runtime-b" });
  const newLease = f.runtime.getCurrentRuntimeLease();
  await f.controller.waitForTurnComposer({ kind: "FRESH_ROOT" }, newLease);

  assert.equal(f.freshClockCalls(), 2);
});

test("root mismatch followed by a changed composer cannot consume stale fresh proof", async () => {
  const f = freshProofFixture();
  const lease = f.runtime.getCurrentRuntimeLease();

  await f.controller.waitForFreshRoute(lease);
  f.observation.mismatchRootOnce = true;
  f.observation.backendDOMNodeId = 303;
  await f.controller.waitForTurnComposer({ kind: "FRESH_ROOT" }, lease);

  assert.equal(f.freshClockCalls(), 2);
});

type RequestListener = (event: {
  requestId: string;
  request: { url: string; method?: string };
}) => void;
type ResponseListener = (event: { requestId: string; response: { status: number } }) => void;
type SettledListener = (event: { requestId: string }) => void;

type WriteMode = "NONE" | "UNKNOWN_SAME_ID" | "DISTINCT_IDS";

class MultiWriteCriClient {
  public writeMode: WriteMode = "NONE";
  public readonly frame = {
    id: "main",
    loaderId: "loader",
    url: "https://chatgpt.com/c/m5-multi-write",
  };
  private readonly requestListeners = new Set<RequestListener>();
  private readonly responseListeners = new Set<ResponseListener>();
  private readonly finishedListeners = new Set<SettledListener>();
  private readonly failedListeners = new Set<SettledListener>();
  private readonly disconnectListeners = new Set<() => void>();

  public readonly Page = {
    navigate: async (_params: { url: string }) => ({}),
    reload: async (_params?: { ignoreCache?: boolean }) => ({}),
    getFrameTree: async () => ({ frameTree: { frame: this.frame } }),
  };

  public readonly Accessibility = {
    getFullAXTree: async (_params: { frameId: string }) => ({
      nodes: [
        {
          ignored: false,
          role: { value: "textbox" },
          value: { value: "" },
          backendDOMNodeId: 501,
          properties: [
            { name: "multiline", value: { value: true } },
            { name: "focusable", value: { value: true } },
            { name: "editable", value: { value: "richtext" } },
            { name: "focused", value: { value: true } },
          ],
        },
      ],
    }),
  };

  public readonly DOM = {
    focus: async (_params: { backendNodeId: number }) => undefined,
  };

  public readonly Network = {
    enable: async (_options: Record<string, unknown>) => undefined,
    requestWillBeSent: (listener: RequestListener) => {
      this.requestListeners.add(listener);
      return () => this.requestListeners.delete(listener);
    },
    responseReceived: (listener: ResponseListener) => {
      this.responseListeners.add(listener);
      return () => this.responseListeners.delete(listener);
    },
    loadingFinished: (listener: SettledListener) => {
      this.finishedListeners.add(listener);
      return () => this.finishedListeners.delete(listener);
    },
    loadingFailed: (listener: SettledListener) => {
      this.failedListeners.add(listener);
      return () => this.failedListeners.delete(listener);
    },
  };

  public readonly Input = {
    insertText: async (_params: { text: string }) => undefined,
    dispatchKeyEvent: async (params: Readonly<Record<string, unknown>>) => {
      if (params.type !== "keyDown") {
        return;
      }
      if (this.writeMode === "UNKNOWN_SAME_ID") {
        this.emitWrite("write-a");
        this.emitWrite("write-a");
        this.emitResponse("write-a", 200);
        this.emitFinished("write-a");
      } else if (this.writeMode === "DISTINCT_IDS") {
        this.emitWrite("write-a");
        this.emitResponse("write-a", 200);
        this.emitWrite("write-b");
        this.emitFinished("write-a");
      }
    },
  };

  public async close(): Promise<void> {}

  public on(event: "disconnect", listener: () => void): void {
    if (event === "disconnect") {
      this.disconnectListeners.add(listener);
    }
  }

  private emitWrite(requestId: string): void {
    for (const listener of this.requestListeners) {
      listener({
        requestId,
        request: {
          url: "https://chatgpt.com/backend-api/f/conversation",
          method: "POST",
        },
      });
    }
  }

  private emitResponse(requestId: string, status: number): void {
    for (const listener of this.responseListeners) {
      listener({ requestId, response: { status } });
    }
  }

  private emitFinished(requestId: string): void {
    for (const listener of this.finishedListeners) {
      listener({ requestId });
    }
  }
}

class SessionTurnPort implements TurnCdpPort {
  public constructor(
    private readonly runtime: RuntimeGenerationTracker,
    private readonly session: CdpTurnTransportSession,
  ) {}

  public async getTurnComposerState(
    expectedRoute: RouteExpectation,
    lease: RuntimeLease,
  ): Promise<CdpTurnComposerState> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    return await this.session.getTurnComposerState(expectedRoute);
  }

  public armTurnObservation(lease: RuntimeLease): CdpTurnObservationHandle {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    return this.session.armTurnObservation();
  }

  public getTurnObservation(
    handle: CdpTurnObservationHandle,
    lease: RuntimeLease,
  ): CdpTurnObservationSnapshot {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    return this.session.getTurnObservation(handle);
  }

  public releaseTurnObservation(handle: CdpTurnObservationHandle): void {
    this.session.releaseTurnObservation(handle);
  }

  public async insertText(text: string, lease: RuntimeLease): Promise<void> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    await this.session.insertText(text);
  }

  public async dispatchEnterKeyDown(lease: RuntimeLease): Promise<void> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    await this.session.dispatchEnterKeyDown();
  }

  public async dispatchEnterKeyUp(lease: RuntimeLease): Promise<void> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    await this.session.dispatchEnterKeyUp();
  }

  public async getCurrentConversationLocator(
    lease: RuntimeLease,
  ): Promise<ConversationLocator | null> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    return await this.session.getCurrentConversationLocator();
  }
}

const multiWriteTarget: CdpTargetInfo = {
  id: "m5-multi-write-target",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/m5-multi-write",
  url: "https://chatgpt.com/c/m5-multi-write",
};

async function multiWriteFixture(mode: WriteMode) {
  const runtime = createRuntime();
  const scheduler = new OperationScheduler(runtime);
  const registry = new ThreadRegistry({ handleFactory: () => "multi_write_handle" });
  const locator = createConversationLocator("https://chatgpt.com/c/m5-multi-write");
  const handle = registry.register(locator);
  const client = new MultiWriteCriClient();
  client.writeMode = mode;
  const transport = new ChromeRemoteInterfaceTransport({ connect: async () => client });
  const session = (await transport.connect({
    host: "127.0.0.1",
    port: 9223,
    target: multiWriteTarget,
  })) as CdpTurnTransportSession;
  await session.initializeReadinessObservation();
  const executor = new TurnExecutor(
    registry,
    scheduler,
    new NoopPreflight(),
    new SessionTurnPort(runtime, session),
    {
      commandTimeoutMs: 50,
      writeObservationTimeoutMs: 5,
      writeSettlementTimeoutMs: 5,
      freshConversationTimeoutMs: 5,
      pollIntervalMs: 1,
      sleep: async () => undefined,
    },
  );
  return { scheduler, handle, executor };
}

test("distinct second conversation write fails closed even after the selected first write finishes", async () => {
  const f = await multiWriteFixture("DISTINCT_IDS");

  await assert.rejects(
    () => f.executor.execute({ kind: "THREAD", threadHandle: f.handle }, "synthetic prompt"),
    TurnStateUncertainError,
  );

  let routeRan = false;
  await assert.rejects(
    () =>
      f.scheduler.schedule("ROUTE", async () => {
        routeRan = true;
      }),
    TurnStateUncertainError,
  );
  assert.equal(routeRan, false);
});

test("same request ID repeat without redirect metadata fails closed", async () => {
  const f = await multiWriteFixture("UNKNOWN_SAME_ID");

  await assert.rejects(
    () => f.executor.execute({ kind: "THREAD", threadHandle: f.handle }, "synthetic prompt"),
    TurnStateUncertainError,
  );

  let routeRan = false;
  await assert.rejects(
    () =>
      f.scheduler.schedule("ROUTE", async () => {
        routeRan = true;
      }),
    TurnStateUncertainError,
  );
  assert.equal(routeRan, false);
});
