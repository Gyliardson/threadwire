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
  FreshConversationNotCreatedError,
  OperationAbortedError,
  TurnStateUncertainError,
  TurnWriteFailedError,
} from "../../src/domain/errors.js";
import { ConversationLocator, createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import { RouteExpectation } from "../../src/readiness/types.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";
import { ThreadRegistry } from "../../src/routing/ThreadRegistry.js";
import { TurnExecutor } from "../../src/turn/TurnExecutor.js";
import { TurnCdpPort, TurnComposerPreflightPort } from "../../src/turn/types.js";

class ManualSleep {
  public entries = 0;
  private readonly releases: Array<() => void> = [];
  private readonly entryWaiters: Array<{ target: number; done: () => void }> = [];

  public readonly sleep = async (_ms: number): Promise<void> => {
    this.entries += 1;
    for (let index = this.entryWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.entryWaiters[index];
      if (waiter !== undefined && this.entries >= waiter.target) {
        this.entryWaiters.splice(index, 1);
        waiter.done();
      }
    }
    await new Promise<void>((resolve) => this.releases.push(resolve));
  };

  public async waitForEntry(target: number): Promise<void> {
    if (this.entries >= target) {
      return;
    }
    await new Promise<void>((resolve) => this.entryWaiters.push({ target, done: resolve }));
  }

  public releaseOne(): void {
    const release = this.releases.shift();
    if (release === undefined) {
      throw new Error("No blocked M5 polling sleep is available to release.");
    }
    release();
  }
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

const freshLocator = createConversationLocator("https://chatgpt.com/c/m5-early-route");
const differentFreshLocator = createConversationLocator("https://chatgpt.com/c/m5-different-route");

class EarlyRouteCriClient {
  public frame = {
    id: "main",
    loaderId: "loader-root",
    url: "https://chatgpt.com/",
  };
  public frameTreeReads = 0;
  public blockFrameTreeReadAt: number | null = null;
  private frameTreeRelease: (() => void) | null = null;
  private frameTreeBlockedResolve!: () => void;
  public readonly frameTreeBlocked = new Promise<void>((resolve) => {
    this.frameTreeBlockedResolve = resolve;
  });
  private readonly requestListeners = new Set<RequestListener>();
  private readonly responseListeners = new Set<ResponseListener>();
  private readonly finishedListeners = new Set<SettledListener>();
  private readonly failedListeners = new Set<SettledListener>();
  private readonly disconnectListeners = new Set<() => void>();

  public readonly Page = {
    navigate: async (_params: { url: string }) => ({}),
    getFrameTree: async () => {
      this.frameTreeReads += 1;
      if (this.frameTreeReads === this.blockFrameTreeReadAt) {
        this.frameTreeBlockedResolve();
        await new Promise<void>((resolve) => {
          this.frameTreeRelease = resolve;
        });
      }
      return { frameTree: { frame: this.frame } };
    },
  };

  public readonly Accessibility = {
    getFullAXTree: async (_params: { frameId: string }) => ({
      nodes: [
        {
          ignored: false,
          role: { value: "textbox" },
          value: { value: "" },
          backendDOMNodeId: 701,
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
      this.frame = {
        id: "main",
        loaderId: "loader-conversation",
        url: freshLocator,
      };
    },
  };

  public async close(): Promise<void> {}

  public on(event: "disconnect", listener: () => void): void {
    if (event === "disconnect") {
      this.disconnectListeners.add(listener);
    }
  }

  public releaseBlockedFrameTreeRead(): void {
    const release = this.frameTreeRelease;
    if (release === null) {
      throw new Error("No blocked frame-tree read is available to release.");
    }
    this.frameTreeRelease = null;
    release();
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

  public emitFinished(requestId = "write-a"): void {
    for (const listener of this.finishedListeners) {
      listener({ requestId });
    }
  }

  public emitFailed(requestId = "write-a"): void {
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
  id: "m5-early-route",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/m5-early-route",
  url: "https://chatgpt.com/",
};

async function fixture(options: { settlementTimeoutMs?: number } = {}) {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 700, creationTime: "m5-fresh-ordering-a" });
  const scheduler = new OperationScheduler(runtime);
  let handleIndex = 0;
  const registry = new ThreadRegistry({ handleFactory: () => `fresh_order_${++handleIndex}` });
  const client = new EarlyRouteCriClient();
  const transport = new ChromeRemoteInterfaceTransport({ connect: async () => client });
  const session = (await transport.connect({ host: "127.0.0.1", port: 9223, target })) as CdpTurnTransportSession;
  await session.initializeReadinessObservation();
  const manualSleep = new ManualSleep();
  const now = { value: 0 };
  const executor = new TurnExecutor(
    registry,
    scheduler,
    new NoopPreflight(),
    new SessionTurnPort(runtime, session),
    {
      commandTimeoutMs: 100,
      writeObservationTimeoutMs: 20,
      writeSettlementTimeoutMs: options.settlementTimeoutMs ?? 20,
      freshConversationTimeoutMs: 20,
      pollIntervalMs: 1,
      clock: () => now.value,
      sleep: manualSleep.sleep,
    },
  );
  return {
    runtime,
    scheduler,
    registry,
    client,
    manualSleep,
    now,
    executor,
    handleAllocations: () => handleIndex,
  };
}

function observeSettlement<T>(promise: Promise<T>): { readonly settled: () => boolean } {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { settled: () => done };
}

function errorGraphContainsText(value: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof value === "string") {
    return value.includes(needle);
  }
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (value instanceof Error) {
    if (value.name.includes(needle) || value.message.includes(needle)) {
      return true;
    }
    if ("cause" in value && errorGraphContainsText((value as Error & { cause?: unknown }).cause, needle, seen)) {
      return true;
    }
  }

  return Object.values(value as Record<string, unknown>).some((nested) =>
    errorGraphContainsText(nested, needle, seen),
  );
}

test("FRESH early route succeeds only after later write settlement and final route congruence", async () => {
  const f = await fixture();
  const turn = f.executor.execute({ kind: "FRESH" }, "synthetic prompt");
  const state = observeSettlement(turn);

  await f.manualSleep.waitForEntry(1);
  assert.equal(state.settled(), false, "capturing the /c/... route while write A is ACTIVE must not resolve FRESH");
  assert.equal(f.handleAllocations(), 0, "captured locator must not be registered before settlement");

  f.manualSleep.releaseOne();
  await f.manualSleep.waitForEntry(2);
  assert.equal(state.settled(), false, "a later polling iteration with A still ACTIVE must keep TURN ownership");
  assert.equal(f.handleAllocations(), 0);
  assert.equal(f.client.frame.url, freshLocator);

  f.client.emitFinished();
  f.manualSleep.releaseOne();

  const result = await turn;
  assert.equal(result.created, true);
  assert.equal(f.registry.resolve(result.threadHandle), freshLocator);
  assert.equal(f.registry.knownThreads().length, 1);
  assert.equal(f.handleAllocations(), 1);

  let routeRan = false;
  await f.scheduler.schedule("ROUTE", async () => {
    routeRan = true;
  });
  assert.equal(routeRan, true, "successful settlement must not poison the runtime uncertainty latch");
});

test("FRESH captured locator that becomes unsupported is not registered and times out safely", async () => {
  const f = await fixture();
  const turn = f.executor.execute({ kind: "FRESH" }, "synthetic prompt");

  await f.manualSleep.waitForEntry(1);
  f.client.frame = {
    id: "main",
    loaderId: "loader-root-again",
    url: "https://chatgpt.com/",
  };
  f.client.emitFinished();
  f.manualSleep.releaseOne();

  await f.manualSleep.waitForEntry(2);
  assert.equal(f.registry.knownThreads().length, 0);
  assert.equal(f.handleAllocations(), 0, "stale captured locator must not be registered while current route is unsupported");

  f.now.value = 20;
  f.manualSleep.releaseOne();

  await assert.rejects(turn, FreshConversationNotCreatedError);
  assert.equal(f.registry.knownThreads().length, 0);
  assert.equal(f.handleAllocations(), 0);
});

test("FRESH captured locator that changes to a different supported locator fails without registration", async () => {
  const f = await fixture();
  const turn = f.executor.execute({ kind: "FRESH" }, "synthetic prompt");

  await f.manualSleep.waitForEntry(1);
  f.client.frame = {
    id: "main",
    loaderId: "loader-different-conversation",
    url: differentFreshLocator,
  };
  f.client.emitFinished();
  f.manualSleep.releaseOne();

  let captured: unknown;
  try {
    await turn;
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof FreshConversationNotCreatedError);
  assert.equal(f.registry.knownThreads().length, 0);
  assert.equal(f.handleAllocations(), 0, "neither captured nor current differing locator may allocate a handle");
  assert.equal(errorGraphContainsText(captured, "m5-early-route"), false);
  assert.equal(errorGraphContainsText(captured, "m5-different-route"), false);
});

test("FRESH late distinct write during final route revalidation fails closed before registration", async () => {
  const f = await fixture();
  f.client.blockFrameTreeReadAt = 3;
  const turn = f.executor.execute({ kind: "FRESH" }, "synthetic prompt");

  await f.manualSleep.waitForEntry(1);
  f.client.emitFinished();
  f.manualSleep.releaseOne();

  await f.client.frameTreeBlocked;
  assert.equal(f.handleAllocations(), 0, "final route await must occur before registration");
  f.client.emitWrite("write-b");
  f.client.releaseBlockedFrameTreeRead();

  await assert.rejects(turn, TurnStateUncertainError);
  assert.equal(f.registry.knownThreads().length, 0);
  assert.equal(f.handleAllocations(), 0, "ambiguous write delivered during final route await must prevent registration");
});

test("FRESH early route followed by exact write failure returns TURN_WRITE_FAILED without registration", async () => {
  const f = await fixture();
  const turn = f.executor.execute({ kind: "FRESH" }, "synthetic prompt");

  await f.manualSleep.waitForEntry(1);
  assert.equal(f.handleAllocations(), 0);
  f.client.emitFailed();
  f.manualSleep.releaseOne();

  await assert.rejects(turn, TurnWriteFailedError);
  assert.equal(f.handleAllocations(), 0, "failed write must not register the captured locator");
});

test("FRESH early route keeps waiting until the existing write settlement deadline then fails closed", async () => {
  const f = await fixture({ settlementTimeoutMs: 5 });
  const turn = f.executor.execute({ kind: "FRESH" }, "synthetic prompt");

  await f.manualSleep.waitForEntry(1);
  let routeCallbackCount = 0;
  const queuedRoute = f.scheduler.schedule("ROUTE", async () => {
    routeCallbackCount += 1;
  });
  await Promise.resolve();
  assert.equal(routeCallbackCount, 0);
  assert.equal(f.handleAllocations(), 0);

  f.now.value = 5;
  f.manualSleep.releaseOne();

  await assert.rejects(turn, TurnStateUncertainError);
  await assert.rejects(queuedRoute, TurnStateUncertainError);
  assert.equal(routeCallbackCount, 0);
  assert.equal(f.handleAllocations(), 0);
  await assert.rejects(
    () => f.scheduler.schedule("TURN", async () => undefined),
    TurnStateUncertainError,
  );
});

test("FRESH late distinct write after locator capture still fails closed and blocks queued ROUTE", async () => {
  const f = await fixture();
  const turn = f.executor.execute({ kind: "FRESH" }, "synthetic prompt");

  await f.manualSleep.waitForEntry(1);
  let routeCallbackCount = 0;
  const queuedRoute = f.scheduler.schedule("ROUTE", async () => {
    routeCallbackCount += 1;
  });
  await Promise.resolve();
  assert.equal(routeCallbackCount, 0);
  assert.equal(f.handleAllocations(), 0);

  f.client.emitWrite("write-b");
  f.manualSleep.releaseOne();

  await assert.rejects(turn, TurnStateUncertainError);
  await assert.rejects(queuedRoute, TurnStateUncertainError);
  assert.equal(routeCallbackCount, 0);
  assert.equal(f.handleAllocations(), 0, "ambiguous turn must not register the captured locator");
});

test("FRESH post-commit abort with early locator waits for FINISHED before outward abort", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const turn = f.executor.execute({ kind: "FRESH" }, "synthetic prompt", abort.signal);
  const state = observeSettlement(turn);

  await f.manualSleep.waitForEntry(1);
  abort.abort(new Error("cancel after early locator capture"));
  await Promise.resolve();
  assert.equal(state.settled(), false, "caller abort must not release TURN while exact write remains ACTIVE");

  f.manualSleep.releaseOne();
  await f.manualSleep.waitForEntry(2);
  assert.equal(state.settled(), false, "post-commit abort must remain deferred across another ACTIVE poll");

  f.client.emitFinished();
  f.manualSleep.releaseOne();
  await assert.rejects(turn, OperationAbortedError);
  assert.equal(f.handleAllocations(), 0, "aborted fresh result must not be registered");
});

test("FRESH post-commit abort with early locator preserves FAILED write precedence", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const turn = f.executor.execute({ kind: "FRESH" }, "synthetic prompt", abort.signal);

  await f.manualSleep.waitForEntry(1);
  abort.abort(new Error("cancel after early locator capture"));
  f.client.emitFailed();
  f.manualSleep.releaseOne();

  await assert.rejects(turn, TurnWriteFailedError);
  assert.equal(f.handleAllocations(), 0);
});
