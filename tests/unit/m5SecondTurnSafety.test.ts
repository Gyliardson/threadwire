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
  TurnInputFailedError,
  TurnStateUncertainError,
  TurnWriteFailedError,
} from "../../src/domain/errors.js";
import {
  ConversationLocator,
  createConversationLocator,
} from "../../src/domain/ThreadIdentity.js";
import { RouteExpectation } from "../../src/readiness/types.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";
import { ThreadRegistry } from "../../src/routing/ThreadRegistry.js";
import { TurnExecutor } from "../../src/turn/TurnExecutor.js";
import { TurnCdpPort, TurnComposerPreflightPort } from "../../src/turn/types.js";

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

function runtimeFixture(): RuntimeGenerationTracker {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 500, creationTime: "m5-second-a" });
  return runtime;
}

class NoopPreflight implements TurnComposerPreflightPort {
  public async waitForTurnComposer(
    _expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<void> {}
}

type RequestListener = (event: {
  requestId: string;
  request: { url: string; method?: string };
}) => void;
type ResponseListener = (event: { requestId: string; response: { status: number } }) => void;
type SettledListener = (event: { requestId: string }) => void;

type LateWriteMode = "ACTIVE" | "TERMINAL";

class LateWriteCriClient {
  public frame = {
    id: "main",
    loaderId: "loader-root",
    url: "https://chatgpt.com/",
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
          backendDOMNodeId: 901,
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
      this.emitWrite("write-a");
      this.emitResponse("write-a", 200);
      this.emitFinished("write-a");
    },
  };

  public async close(): Promise<void> {}

  public on(event: "disconnect", listener: () => void): void {
    if (event === "disconnect") {
      this.disconnectListeners.add(listener);
    }
  }

  public emitWrite(requestId: string): void {
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

  public emitResponse(requestId: string, status: number): void {
    for (const listener of this.responseListeners) {
      listener({ requestId, response: { status } });
    }
  }

  public emitFinished(requestId: string): void {
    for (const listener of this.finishedListeners) {
      listener({ requestId });
    }
  }
}

class LateWritePort implements TurnCdpPort {
  public readonly routeReadStarted = deferred<void>();
  public readonly releaseRouteRead = deferred<void>();
  private injectedLateWrite = false;

  public constructor(
    private readonly runtime: RuntimeGenerationTracker,
    private readonly session: CdpTurnTransportSession,
    private readonly client: LateWriteCriClient,
    private readonly lateWriteMode: LateWriteMode,
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

  public async clickExistingTurnSendButton(

    _conversationLocator: unknown,

    _backendDOMNodeId: number,

    _expectedText: string,

    lease: RuntimeLease,

  ): Promise<void> {

    await this.dispatchEnterKeyDown(lease);

    await this.dispatchEnterKeyUp(lease);

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
    this.routeReadStarted.resolve();
    await this.releaseRouteRead.promise;
    const locatorBeforeLateWrite = await this.session.getCurrentConversationLocator();

    if (!this.injectedLateWrite) {
      this.injectedLateWrite = true;
      this.client.emitWrite("write-b");
      if (this.lateWriteMode === "TERMINAL") {
        this.client.emitResponse("write-b", 200);
        this.client.emitFinished("write-b");
      }
      this.client.frame = {
        id: "main",
        loaderId: "loader-conversation",
        url: "https://chatgpt.com/c/m5-late-write-created",
      };
    }

    return locatorBeforeLateWrite;
  }
}

const lateWriteTarget: CdpTargetInfo = {
  id: "m5-late-write",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/m5-late-write",
  url: "https://chatgpt.com/",
};

async function lateWriteFixture(mode: LateWriteMode) {
  const runtime = runtimeFixture();
  const scheduler = new OperationScheduler(runtime);
  const registry = new ThreadRegistry({ handleFactory: () => "late_write_handle" });
  const client = new LateWriteCriClient();
  const transport = new ChromeRemoteInterfaceTransport({ connect: async () => client });
  const session = (await transport.connect({
    host: "127.0.0.1",
    port: 9223,
    target: lateWriteTarget,
  })) as CdpTurnTransportSession;
  await session.initializeReadinessObservation();
  const port = new LateWritePort(runtime, session, client, mode);
  const executor = new TurnExecutor(registry, scheduler, new NoopPreflight(), port, {
    commandTimeoutMs: 100,
    writeObservationTimeoutMs: 20,
    writeSettlementTimeoutMs: 20,
    freshConversationTimeoutMs: 20,
    pollIntervalMs: 1,
    sleep: async () => undefined,
  });
  return { runtime, scheduler, port, executor };
}

for (const mode of ["ACTIVE", "TERMINAL"] as const) {
  test(`late distinct write after consumed FINISHED fresh write fails closed (${mode})`, async () => {
    const f = await lateWriteFixture(mode);
    const turn = f.executor.execute({ kind: "FRESH" }, "synthetic prompt");
    await f.port.routeReadStarted.promise;

    let routeCallbackCount = 0;
    const queuedRoute = f.scheduler.schedule("ROUTE", async () => {
      routeCallbackCount += 1;
    });
    await Promise.resolve();
    assert.equal(routeCallbackCount, 0, "ROUTE must be genuinely queued behind the active TURN");

    f.port.releaseRouteRead.resolve();
    await assert.rejects(turn, TurnStateUncertainError);
    await assert.rejects(queuedRoute, TurnStateUncertainError);
    assert.equal(routeCallbackCount, 0);

    await assert.rejects(
      () => f.scheduler.schedule("TURN", async () => undefined),
      TurnStateUncertainError,
    );

    f.runtime.observe({ pid: 501, creationTime: "m5-second-b" });
    let replacementRouteRan = false;
    await f.scheduler.schedule("ROUTE", async () => {
      replacementRouteRan = true;
    });
    assert.equal(replacementRouteRan, true, "old-generation uncertainty must not poison replacement runtime");
  });
}

const simpleObservationHandle = Object.freeze({}) as unknown as CdpTurnObservationHandle;

class PreSubmitWriteCdp implements TurnCdpPort {
  public readonly insertReached = deferred<void>();
  public readonly releaseInsert = deferred<void>();
  public keyDownCalls = 0;

  public constructor(
    private readonly runtime: RuntimeGenerationTracker,
    private readonly lifecycle: "ACTIVE" | "FINISHED" | null,
  ) {}

  public async getTurnComposerState(
    _expectedRoute: RouteExpectation,
    lease: RuntimeLease,
  ): Promise<CdpTurnComposerState> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    return Object.freeze({ expectedRoute: true, eligible: true, focused: true, backendDOMNodeId: 101, empty: true });
  }

  public armTurnObservation(lease: RuntimeLease): CdpTurnObservationHandle {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    return simpleObservationHandle;
  }

  public getTurnObservation(
    _handle: CdpTurnObservationHandle,
    lease: RuntimeLease,
  ): CdpTurnObservationSnapshot {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    return Object.freeze({
      prepareCount: 0,
      write: this.lifecycle === null ? null : Object.freeze({ lifecycle: this.lifecycle }),
    });
  }

  public releaseTurnObservation(_handle: CdpTurnObservationHandle): void {}

  public async insertText(_text: string, lease: RuntimeLease): Promise<void> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.insertReached.resolve();
    await this.releaseInsert.promise;
  }

  public async clickExistingTurnSendButton(

    _conversationLocator: unknown,

    _backendDOMNodeId: number,

    _expectedText: string,

    _lease: RuntimeLease,

  ): Promise<void> {

    await this.dispatchEnterKeyDown(_lease);

    await this.dispatchEnterKeyUp(_lease);

  }


  public async dispatchEnterKeyDown(_lease: RuntimeLease): Promise<void> {
    this.keyDownCalls += 1;
  }

  public async dispatchEnterKeyUp(_lease: RuntimeLease): Promise<void> {}

  public async getCurrentConversationLocator(
    _lease: RuntimeLease,
  ): Promise<ConversationLocator | null> {
    return null;
  }
}

function preSubmitFixture(lifecycle: "ACTIVE" | "FINISHED" | null) {
  const runtime = runtimeFixture();
  const scheduler = new OperationScheduler(runtime);
  const registry = new ThreadRegistry({ handleFactory: () => "pre_submit_handle" });
  const locator = createConversationLocator("https://chatgpt.com/c/m5-pre-submit");
  const handle = registry.register(locator);
  const cdp = new PreSubmitWriteCdp(runtime, lifecycle);
  const executor = new TurnExecutor(registry, scheduler, new NoopPreflight(), cdp, {
    commandTimeoutMs: 100,
    writeObservationTimeoutMs: 10,
    writeSettlementTimeoutMs: 10,
    freshConversationTimeoutMs: 10,
    pollIntervalMs: 1,
    sleep: async () => undefined,
  });
  return { scheduler, handle, cdp, executor };
}

test("observed ACTIVE pre-submit write blocks queued ROUTE even when caller aborts before Enter", async () => {
  const f = preSubmitFixture("ACTIVE");
  const abort = new AbortController();
  const turn = f.executor.execute(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
    abort.signal,
  );
  await f.cdp.insertReached.promise;

  abort.abort(new Error("cancel before Enter"));
  let routeCallbackCount = 0;
  const route = f.scheduler.schedule("ROUTE", async () => {
    routeCallbackCount += 1;
  });
  f.cdp.releaseInsert.resolve();

  await assert.rejects(turn, TurnStateUncertainError);
  await assert.rejects(route, TurnStateUncertainError);
  assert.equal(routeCallbackCount, 0);
  assert.equal(f.cdp.keyDownCalls, 0);
});

test("terminal pre-submit write is safe to release but cannot be reported as this turn success", async () => {
  const f = preSubmitFixture("FINISHED");
  const turn = f.executor.execute(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
  );
  await f.cdp.insertReached.promise;
  f.cdp.releaseInsert.resolve();

  await assert.rejects(turn, TurnInputFailedError);
  assert.equal(f.cdp.keyDownCalls, 0);
  let routeRan = false;
  await f.scheduler.schedule("ROUTE", async () => {
    routeRan = true;
  });
  assert.equal(routeRan, true);
});

class ProtocolErrorCdp extends PreSubmitWriteCdp {
  public constructor(runtime: RuntimeGenerationTracker, private readonly rawError: Error) {
    super(runtime, null);
  }

  public override async insertText(_text: string, _lease: RuntimeLease): Promise<void> {
    throw this.rawError;
  }
}

function graphContains(value: unknown, needle: string, seen = new Set<object>()): boolean {
  if (typeof value === "string") {
    return value.includes(needle);
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return false;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    try {
      if (graphContains((value as Record<PropertyKey, unknown>)[key], needle, seen)) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

test("raw ProtocolError-shaped insertText failure cannot retain prompt in outward cause graph", async () => {
  const runtime = runtimeFixture();
  const scheduler = new OperationScheduler(runtime);
  const registry = new ThreadRegistry({ handleFactory: () => "protocol_error_handle" });
  const locator = createConversationLocator("https://chatgpt.com/c/m5-protocol-error");
  const handle = registry.register(locator);
  const raw = new Error("Protocol error");
  Object.defineProperty(raw, "request", {
    value: {
      method: "Input.insertText",
      params: { text: "PROMPT_TEXT_SECRET" },
    },
    enumerable: true,
  });
  const cdp = new ProtocolErrorCdp(runtime, raw);
  const executor = new TurnExecutor(registry, scheduler, new NoopPreflight(), cdp, {
    commandTimeoutMs: 100,
    writeObservationTimeoutMs: 10,
    writeSettlementTimeoutMs: 10,
    freshConversationTimeoutMs: 10,
    pollIntervalMs: 1,
    sleep: async () => undefined,
  });

  let captured: unknown;
  try {
    await executor.execute({ kind: "THREAD", threadHandle: handle }, "PROMPT_TEXT_SECRET");
  } catch (error) {
    captured = error;
  }

  assert.ok(captured instanceof TurnInputFailedError);
  assert.equal(graphContains(captured, "PROMPT_TEXT_SECRET"), false);
});

class AbortFailedWriteCdp implements TurnCdpPort {
  public readonly firstActiveRead = deferred<void>();
  public readonly releaseActiveRead = deferred<void>();
  private submitted = false;
  private postSubmitReads = 0;

  public constructor(private readonly runtime: RuntimeGenerationTracker) {}

  public async getTurnComposerState(
    _expectedRoute: RouteExpectation,
    lease: RuntimeLease,
  ): Promise<CdpTurnComposerState> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    return Object.freeze({ expectedRoute: true, eligible: true, focused: true, backendDOMNodeId: 101, empty: true });
  }

  public armTurnObservation(_lease: RuntimeLease): CdpTurnObservationHandle {
    return simpleObservationHandle;
  }

  public getTurnObservation(
    _handle: CdpTurnObservationHandle,
    _lease: RuntimeLease,
  ): CdpTurnObservationSnapshot {
    if (!this.submitted) {
      return Object.freeze({ prepareCount: 0, write: null });
    }
    this.postSubmitReads += 1;
    if (this.postSubmitReads === 1) {
      this.firstActiveRead.resolve();
      return Object.freeze({ prepareCount: 0, write: Object.freeze({ lifecycle: "ACTIVE" as const }) });
    }
    return Object.freeze({ prepareCount: 0, write: Object.freeze({ lifecycle: "FAILED" as const }) });
  }

  public releaseTurnObservation(_handle: CdpTurnObservationHandle): void {}
  public async insertText(_text: string, _lease: RuntimeLease): Promise<void> {}
  public async clickExistingTurnSendButton(
    _conversationLocator: unknown,
    _backendDOMNodeId: number,
    _expectedText: string,
    _lease: RuntimeLease,
  ): Promise<void> {
    await this.dispatchEnterKeyDown(_lease);
    await this.dispatchEnterKeyUp(_lease);
  }

  public async dispatchEnterKeyDown(_lease: RuntimeLease): Promise<void> {
    this.submitted = true;
  }
  public async dispatchEnterKeyUp(_lease: RuntimeLease): Promise<void> {}
  public async getCurrentConversationLocator(_lease: RuntimeLease): Promise<ConversationLocator | null> {
    return null;
  }
}

test("terminal FAILED write takes precedence over post-submit caller abort", async () => {
  const runtime = runtimeFixture();
  const scheduler = new OperationScheduler(runtime);
  const registry = new ThreadRegistry({ handleFactory: () => "abort_failed_handle" });
  const locator = createConversationLocator("https://chatgpt.com/c/m5-abort-failed");
  const handle = registry.register(locator);
  const cdp = new AbortFailedWriteCdp(runtime);
  const abort = new AbortController();
  let slept = false;
  const executor = new TurnExecutor(registry, scheduler, new NoopPreflight(), cdp, {
    commandTimeoutMs: 100,
    writeObservationTimeoutMs: 20,
    writeSettlementTimeoutMs: 20,
    freshConversationTimeoutMs: 20,
    pollIntervalMs: 1,
    sleep: async () => {
      if (!slept) {
        slept = true;
        await cdp.releaseActiveRead.promise;
      }
    },
  });

  const turn = executor.execute(
    { kind: "THREAD", threadHandle: handle },
    "synthetic prompt",
    abort.signal,
  );
  await cdp.firstActiveRead.promise;
  abort.abort(new Error("post-submit cancellation"));
  cdp.releaseActiveRead.resolve();

  await assert.rejects(turn, TurnWriteFailedError);
});
