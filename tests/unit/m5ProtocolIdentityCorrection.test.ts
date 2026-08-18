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
import { RuntimeGenerationTracker, RuntimeLease } from "../../src/domain/RuntimeGeneration.js";
import {
  TurnStateUncertainError,
  TurnWriteFailedError,
} from "../../src/domain/errors.js";
import { ConversationLocator, createConversationLocator } from "../../src/domain/ThreadIdentity.js";
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

class BlockingSleep {
  public readonly entered = deferred<void>();
  public readonly release = deferred<void>();

  public readonly sleep = async (_ms: number): Promise<void> => {
    this.entered.resolve();
    await this.release.promise;
  };
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
  redirectResponse?: { status: number };
}) => void;
type ResponseListener = (event: { requestId: string; response: { status: number } }) => void;
type SettledListener = (event: { requestId: string }) => void;

const locator = createConversationLocator("https://chatgpt.com/c/m5-protocol-identity");
const conversationWriteUrl = "https://chatgpt.com/backend-api/f/conversation";

class ProtocolIdentityCriClient {
  public keyDownAction: (() => void) | null = null;
  public blockKeyUp = false;
  public readonly keyUpEntered = deferred<void>();
  public readonly releaseKeyUp = deferred<void>();
  public readonly frame = {
    id: "main",
    loaderId: "loader",
    url: locator,
  };
  private readonly requestListeners = new Set<RequestListener>();
  private readonly responseListeners = new Set<ResponseListener>();
  private readonly finishedListeners = new Set<SettledListener>();
  private readonly failedListeners = new Set<SettledListener>();
  private readonly disconnectListeners = new Set<() => void>();

  public readonly Page = {
    navigate: async (_params: { url: string }) => ({}),
    getFrameTree: async () => ({ frameTree: { frame: this.frame } }),
  };

  public readonly Accessibility = {
    getFullAXTree: async (_params: { frameId: string }) => ({
      nodes: [
        {
          ignored: false,
          role: { value: "textbox" },
          value: { value: "" },
          backendDOMNodeId: 801,
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

  public readonly Input = {
    insertText: async (_params: { text: string }) => undefined,
    dispatchKeyEvent: async (params: Readonly<Record<string, unknown>>) => {
      if (params.type === "keyDown") {
        this.keyDownAction?.();
        return;
      }
      if (params.type === "keyUp" && this.blockKeyUp) {
        this.keyUpEntered.resolve();
        await this.releaseKeyUp.promise;
      }
    },
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

  public async close(): Promise<void> {}

  public on(event: "disconnect", listener: () => void): void {
    if (event === "disconnect") {
      this.disconnectListeners.add(listener);
    }
  }

  public emitRequest(
    requestId: string,
    url = conversationWriteUrl,
    method = "POST",
    redirected = false,
  ): void {
    for (const listener of this.requestListeners) {
      if (redirected) {
        listener({
          requestId,
          request: { url, method },
          redirectResponse: { status: 302 },
        });
      } else {
        listener({ requestId, request: { url, method } });
      }
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

  public emitFailed(requestId: string): void {
    for (const listener of this.failedListeners) {
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

const target: CdpTargetInfo = {
  id: "m5-protocol-identity",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/m5-protocol-identity",
  url: locator,
};

async function createSession(client = new ProtocolIdentityCriClient()) {
  const transport = new ChromeRemoteInterfaceTransport({ connect: async () => client });
  const session = (await transport.connect({
    host: "127.0.0.1",
    port: 9223,
    target,
  })) as CdpTurnTransportSession;
  await session.initializeReadinessObservation();
  return { client, session };
}

async function createTurnFixture() {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 800, creationTime: "m5-protocol-identity" });
  const scheduler = new OperationScheduler(runtime);
  const registry = new ThreadRegistry({ handleFactory: () => "protocol_identity_handle" });
  const handle = registry.register(locator);
  const { client, session } = await createSession();
  const blockingSleep = new BlockingSleep();
  const executor = new TurnExecutor(
    registry,
    scheduler,
    new NoopPreflight(),
    new SessionTurnPort(runtime, session),
    {
      commandTimeoutMs: 100,
      writeObservationTimeoutMs: 20,
      writeSettlementTimeoutMs: 20,
      freshConversationTimeoutMs: 20,
      pollIntervalMs: 1,
      sleep: blockingSleep.sleep,
    },
  );
  return { scheduler, handle, client, session, blockingSleep, executor };
}

function observeSettlement<T>(promise: Promise<T>): { readonly settled: () => boolean } {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { settled: () => settled };
}

test("ordinary direct conversation POST still succeeds with 2xx plus loadingFinished", async () => {
  const f = await createTurnFixture();
  f.client.keyDownAction = () => {
    f.client.emitRequest("write-direct");
    f.client.emitResponse("write-direct", 200);
    f.client.emitFinished("write-direct");
  };

  const result = await f.executor.execute(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
  );
  assert.equal(result.created, false);
});

test("redirected selected write retains TURN until chain settlement then returns TURN_WRITE_FAILED", async () => {
  const f = await createTurnFixture();
  f.client.keyDownAction = () => {
    f.client.emitRequest("write-a");
    f.client.emitRequest(
      "write-a",
      "https://chatgpt.com/backend-api/f/conversation/redirect-target",
      "GET",
      true,
    );
  };

  const turn = f.executor.execute(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
  );
  const state = observeSettlement(turn);
  await f.blockingSleep.entered.promise;
  assert.equal(state.settled(), false, "understood redirect chain must remain owned while Network is active");

  let routeCallbackCount = 0;
  const queuedRoute = f.scheduler.schedule("ROUTE", async () => {
    routeCallbackCount += 1;
  });
  await Promise.resolve();
  assert.equal(routeCallbackCount, 0, "ROUTE must remain queued behind the active redirected chain");

  f.client.emitResponse("write-a", 200);
  await Promise.resolve();
  assert.equal(state.settled(), false, "later-hop 2xx must not release or upgrade the selected leg");
  assert.equal(routeCallbackCount, 0);

  f.client.emitFinished("write-a");
  f.blockingSleep.release.resolve();

  await assert.rejects(turn, TurnWriteFailedError);
  await queuedRoute;
  assert.equal(routeCallbackCount, 1, "safe terminal write failure must release queued navigation without uncertainty latch");
});

test("later-hop 2xx cannot overwrite sticky selected-leg redirect failure", async () => {
  const { client, session } = await createSession();
  const handle = session.armTurnObservation();

  client.emitRequest("write-a");
  client.emitRequest(
    "write-a",
    "https://chatgpt.com/backend-api/f/conversation/redirect-target",
    "GET",
    true,
  );
  client.emitResponse("write-a", 200);
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "ACTIVE");

  client.emitFinished("write-a");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "FAILED");
});

test("same-ID requestWillBeSent without redirect metadata fails closed and blocks queued ROUTE", async () => {
  const f = await createTurnFixture();
  f.client.blockKeyUp = true;
  f.client.keyDownAction = () => {
    f.client.emitRequest("write-a");
    f.client.emitRequest("write-a");
  };

  const turn = f.executor.execute(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
  );
  await f.client.keyUpEntered.promise;

  let routeCallbackCount = 0;
  const queuedRoute = f.scheduler.schedule("ROUTE", async () => {
    routeCallbackCount += 1;
  });
  await Promise.resolve();
  assert.equal(routeCallbackCount, 0);

  f.client.releaseKeyUp.resolve();
  await assert.rejects(turn, TurnStateUncertainError);
  await assert.rejects(queuedRoute, TurnStateUncertainError);
  assert.equal(routeCallbackCount, 0);
});

test("terminal selected write cannot reopen on later same-ID requestWillBeSent", async () => {
  const { client, session } = await createSession();
  const handle = session.armTurnObservation();

  client.emitRequest("write-a");
  client.emitResponse("write-a", 200);
  client.emitFinished("write-a");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "FINISHED");

  client.emitRequest("write-a", conversationWriteUrl, "POST", true);
  assert.throws(
    () => session.getTurnObservation(handle),
    /ambiguous|unsafe/i,
    "post-terminal same-ID event must become explicitly unsafe rather than reopening ACTIVE",
  );
  client.emitFinished("write-a");
  assert.throws(() => session.getTurnObservation(handle), /ambiguous|unsafe/i);
});

test("different matching requestId remains permanently ambiguous", async () => {
  const { client, session } = await createSession();
  const handle = session.armTurnObservation();

  client.emitRequest("write-a");
  client.emitRequest("write-b");
  assert.throws(() => session.getTurnObservation(handle), /ambiguous|unsafe/i);

  client.emitResponse("write-a", 200);
  client.emitFinished("write-a");
  assert.throws(() => session.getTurnObservation(handle), /ambiguous|unsafe/i);
});
