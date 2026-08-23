import assert from "node:assert/strict";
import test from "node:test";
import {
  CdpResponseRenderBaseline,
  CdpTurnComposerState,
  CdpTurnObservationHandle,
  CdpTurnObservationOptions,
  CdpTurnObservationSnapshot,
} from "../../src/cdp/CdpTransport.js";
import { RuntimeGenerationTracker, RuntimeLease } from "../../src/domain/RuntimeGeneration.js";
import {
  ConversationLocator,
  createConversationLocator,
} from "../../src/domain/ThreadIdentity.js";
import {
  ResponseParseFailedError,
  ResponseStreamUnavailableError,
  TurnStateUncertainError,
} from "../../src/domain/errors.js";
import { RouteExpectation } from "../../src/readiness/types.js";
import {
  NormalizedResponseStreamEvent,
  ResponseStreamEvent,
} from "../../src/response/types.js";
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
  const promise = new Promise<T>((r) => {
    resolve = r;
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

class FakeStreamingTurnPort implements TurnCdpPort {
  public readonly observationHandle = Object.freeze({}) as unknown as CdpTurnObservationHandle;
  public snapshot: CdpTurnObservationSnapshot = Object.freeze({
    prepareCount: 0,
    write: null,
    response: Object.freeze({ lifecycle: "PENDING" as const, failure: null }),
  });
  public readonly responseEvents: NormalizedResponseStreamEvent[] = [];
  public keyDownAction: (() => void) | null = null;
  public armOptions: CdpTurnObservationOptions | undefined;
  public armError: Error | null = null;
  public observationError: Error | null = null;
  public discarded = false;
  public released = false;
  public runtime: RuntimeGenerationTracker | null = null;
  public insertTextCalls = 0;
  public keyDownCalls = 0;
  public keyUpCalls = 0;
  public baselineCalls = 0;
  public finalSnapshotCalls = 0;
  public finalSnapshot: Readonly<{ text: string }> | null = Object.freeze({ text: "fresh-final" });
  public finalSnapshotExpectedRoute: RouteExpectation | null = null;
  public readonly renderBaseline: CdpResponseRenderBaseline = Object.freeze({
    userCount: 0,
    assistantCount: 0,
  });
  public readonly conversationLocators: Array<ConversationLocator | null> = [];
  public locatorReadCount = 0;
  public blockLocatorReadAt: number | null = null;
  public readonly locatorReadBlocked = deferred<void>();
  public readonly locatorReadRelease = deferred<void>();

  public async getTurnComposerState(
    _expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
  ): Promise<CdpTurnComposerState> {
    return { expectedRoute: true, eligible: true, focused: true, empty: true };
  }
  public async captureTurnResponseRenderBaseline(
    _lease: RuntimeLease,
  ): Promise<CdpResponseRenderBaseline> {
    this.runtime?.assertRuntimeLeaseCurrent(_lease);
    this.baselineCalls += 1;
    return this.renderBaseline;
  }
  public async getFinalRenderedAssistantSnapshot(
    _baseline: CdpResponseRenderBaseline,
    expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
  ): Promise<Readonly<{ text: string }> | null> {
    this.runtime?.assertRuntimeLeaseCurrent(_lease);
    this.finalSnapshotCalls += 1;
    this.finalSnapshotExpectedRoute = expectedRoute;
    return this.finalSnapshot;
  }
  public armTurnObservation(
    _lease: RuntimeLease,
    options?: CdpTurnObservationOptions,
  ): CdpTurnObservationHandle {
    this.armOptions = options;
    if (this.armError !== null) {
      throw this.armError;
    }
    return this.observationHandle;
  }
  public getTurnObservation(
    _handle: CdpTurnObservationHandle,
    _lease: RuntimeLease,
  ): CdpTurnObservationSnapshot {
    this.runtime?.assertRuntimeLeaseCurrent(_lease);
    if (this.observationError !== null) {
      throw this.observationError;
    }
    return this.snapshot;
  }
  public takeTurnResponseEvents(
    _handle: CdpTurnObservationHandle,
    _lease: RuntimeLease,
  ): readonly NormalizedResponseStreamEvent[] {
    return this.responseEvents.splice(0, this.responseEvents.length);
  }
  public discardTurnResponse(_handle: CdpTurnObservationHandle, _lease: RuntimeLease): void {
    this.discarded = true;
    this.responseEvents.splice(0, this.responseEvents.length);
  }
  public releaseTurnObservation(_handle: CdpTurnObservationHandle): void {
    this.released = true;
  }
  public async insertText(_text: string, _lease: RuntimeLease): Promise<void> {
    this.insertTextCalls += 1;
  }
  public async dispatchEnterKeyDown(_lease: RuntimeLease): Promise<void> {
    this.keyDownCalls += 1;
    this.keyDownAction?.();
  }
  public async dispatchEnterKeyUp(_lease: RuntimeLease): Promise<void> {
    this.keyUpCalls += 1;
  }
  public async getCurrentConversationLocator(_lease: RuntimeLease): Promise<ConversationLocator | null> {
    this.locatorReadCount += 1;
    if (this.locatorReadCount === this.blockLocatorReadAt) {
      this.locatorReadBlocked.resolve();
      await this.locatorReadRelease.promise;
    }
    if (this.conversationLocators.length === 0) {
      return null;
    }
    if (this.conversationLocators.length === 1) {
      return this.conversationLocators[0] ?? null;
    }
    return this.conversationLocators.shift() ?? null;
  }
}

function settledState<T>(promise: Promise<T>): () => boolean {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

async function fixture(port = new FakeStreamingTurnPort(), sleep = new BlockingSleep()) {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 600, creationTime: "m6-turn" });
  const scheduler = new OperationScheduler(runtime);
  port.runtime = runtime;
  const registry = new ThreadRegistry({ handleFactory: () => "m6_handle" });
  const locator = createConversationLocator("https://chatgpt.com/c/m6-turn");
  const handle = registry.register(locator);
  const executor = new TurnExecutor(registry, scheduler, new NoopPreflight(), port, {
    commandTimeoutMs: 100,
    writeObservationTimeoutMs: 100,
    writeSettlementTimeoutMs: 100,
    responseCompletionTimeoutMs: 100,
    finalResponseSnapshotTimeoutMs: 100,
    freshConversationTimeoutMs: 100,
    pollIntervalMs: 1,
    sleep: sleep.sleep,
  });
  return { scheduler, registry, handle, port, sleep, executor };
}

async function freshFixture(port = new FakeStreamingTurnPort(), sleep = new BlockingSleep()) {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 610, creationTime: "m6-fresh" });
  const scheduler = new OperationScheduler(runtime);
  port.runtime = runtime;
  let handleIndex = 0;
  const registry = new ThreadRegistry({ handleFactory: () => `m6_fresh_${++handleIndex}` });
  const executor = new TurnExecutor(registry, scheduler, new NoopPreflight(), port, {
    commandTimeoutMs: 100,
    writeObservationTimeoutMs: 100,
    writeSettlementTimeoutMs: 100,
    responseCompletionTimeoutMs: 100,
    finalResponseSnapshotTimeoutMs: 100,
    freshConversationTimeoutMs: 100,
    pollIntervalMs: 1,
    sleep: sleep.sleep,
  });
  return {
    scheduler,
    registry,
    port,
    sleep,
    executor,
    handleAllocations: () => handleIndex,
  };
}

test("response-stream arming capability failure preserves RESPONSE_STREAM_UNAVAILABLE before commit", async () => {
  const f = await fixture();
  f.port.armError = new ResponseStreamUnavailableError();

  await assert.rejects(
    f.executor.executeStreaming(
      { kind: "THREAD", threadHandle: f.handle },
      "synthetic prompt",
      () => undefined,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ResponseStreamUnavailableError);
      assert.equal(error.code, "RESPONSE_STREAM_UNAVAILABLE");
      return true;
    },
  );

  assert.equal(f.port.baselineCalls, 0);
  assert.deepEqual(f.port.armOptions, { responseStream: true });
  assert.equal(f.port.insertTextCalls, 0);
  assert.equal(f.port.keyDownCalls, 0);
  assert.equal(f.port.keyUpCalls, 0);

  let routeRan = false;
  await f.scheduler.schedule("ROUTE", async () => {
    routeRan = true;
  });
  assert.equal(routeRan, true, "pre-commit M6 capability failure must not latch mutation uncertainty");
});

test("FRESH streaming keeps final locator authority and reconciles only after the write is terminal", async () => {
  const f = await freshFixture();
  const earlyLocator = createConversationLocator("https://chatgpt.com/c/m6-fresh-early");
  const finalLocator = createConversationLocator("https://chatgpt.com/c/m6-fresh-final");
  f.port.conversationLocators.push(earlyLocator, finalLocator);
  f.port.finalSnapshot = Object.freeze({ text: "fresh-authoritative" });
  const delivered: ResponseStreamEvent[] = [];

  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "ACTIVE" as const }),
      response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
    });
    f.port.responseEvents.push(
      Object.freeze({ type: "TEXT_DELTA" as const, text: "fresh-answer" }),
      Object.freeze({ type: "COMPLETED" as const }),
    );
  };

  const turn = f.executor.executeStreaming(
    { kind: "FRESH" },
    "synthetic prompt",
    (event) => delivered.push(event),
  );
  const isSettled = settledState(turn);
  await f.sleep.entered.promise;

  assert.deepEqual(delivered, [{ type: "TEXT_DELTA", text: "fresh-answer" }]);
  assert.equal(isSettled(), false, "semantic [DONE] must not redefine transport settlement");
  assert.equal(f.registry.knownThreads().length, 0, "early supported locator must not register while write is ACTIVE");
  assert.equal(f.handleAllocations(), 0);
  assert.equal(f.port.finalSnapshotCalls, 0);

  f.port.snapshot = Object.freeze({
    prepareCount: 1,
    write: Object.freeze({ lifecycle: "FINISHED" as const }),
    response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
  });
  f.sleep.release.resolve();

  const result = await turn;
  assert.equal(result.kind, "THREAD");
  assert.equal(result.created, true);
  assert.equal(f.registry.resolve(result.threadHandle), finalLocator);
  assert.notEqual(f.registry.resolve(result.threadHandle), earlyLocator);
  assert.equal(f.registry.knownThreads().length, 1);
  assert.equal(f.port.finalSnapshotCalls, 0);
  assert.deepEqual(delivered, [
    { type: "TEXT_DELTA", text: "fresh-answer" },
    { type: "FINAL_TEXT", text: "fresh-answer" },
    { type: "COMPLETED" },
  ]);
});

test("FRESH streaming late distinct write during final route revalidation fails closed before registration", async () => {
  const f = await freshFixture();
  const earlyLocator = createConversationLocator("https://chatgpt.com/c/m6-fresh-ambiguity-early");
  const finalLocator = createConversationLocator("https://chatgpt.com/c/m6-fresh-ambiguity-final");
  f.port.conversationLocators.push(earlyLocator, finalLocator);
  f.port.blockLocatorReadAt = 2;
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "ACTIVE" as const }),
      response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
    });
    f.port.responseEvents.push(Object.freeze({ type: "COMPLETED" as const }));
  };

  const turn = f.executor.executeStreaming(
    { kind: "FRESH" },
    "synthetic prompt",
    () => undefined,
  );
  await f.sleep.entered.promise;
  assert.equal(f.registry.knownThreads().length, 0);

  f.port.snapshot = Object.freeze({
    prepareCount: 1,
    write: Object.freeze({ lifecycle: "FINISHED" as const }),
    response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
  });
  f.sleep.release.resolve();

  await f.port.locatorReadBlocked.promise;
  assert.equal(f.registry.knownThreads().length, 0, "registration must remain after awaited final route authority check");
  f.port.observationError = new Error("synthetic late distinct write ambiguity");
  f.port.locatorReadRelease.resolve();

  await assert.rejects(turn, TurnStateUncertainError);
  assert.equal(f.registry.knownThreads().length, 0);
  assert.equal(f.handleAllocations(), 0);
  assert.equal(f.port.finalSnapshotCalls, 0);
  await assert.rejects(
    () => f.scheduler.schedule("ROUTE", async () => undefined),
    TurnStateUncertainError,
  );
});

test("FRESH streaming registers authoritative conversation before surfacing safe M6 normalization failure", async () => {
  const f = await freshFixture();
  const earlyLocator = createConversationLocator("https://chatgpt.com/c/m6-fresh-parse-early");
  const finalLocator = createConversationLocator("https://chatgpt.com/c/m6-fresh-parse-final");
  f.port.conversationLocators.push(earlyLocator, finalLocator);
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "ACTIVE" as const }),
      response: Object.freeze({ lifecycle: "FAILED" as const, failure: "PARSE_FAILED" as const }),
    });
  };

  const turn = f.executor.executeStreaming(
    { kind: "FRESH" },
    "synthetic prompt",
    () => undefined,
  );
  await f.sleep.entered.promise;
  assert.equal(f.registry.knownThreads().length, 0, "M6 failure must not register an early locator before safe M5 settlement");

  f.port.snapshot = Object.freeze({
    prepareCount: 1,
    write: Object.freeze({ lifecycle: "FINISHED" as const }),
    response: Object.freeze({ lifecycle: "FAILED" as const, failure: "PARSE_FAILED" as const }),
  });
  f.sleep.release.resolve();

  await assert.rejects(turn, ResponseParseFailedError);
  const handles = f.registry.knownThreads();
  assert.equal(handles.length, 1, "safe conversation creation remains authoritative despite independent M6 failure");
  assert.equal(f.registry.resolve(handles[0]!), finalLocator);
  assert.notEqual(f.registry.resolve(handles[0]!), earlyLocator);
  assert.equal(f.handleAllocations(), 1);
  assert.equal(f.port.finalSnapshotCalls, 0);

  let routeRan = false;
  await f.scheduler.schedule("ROUTE", async () => {
    routeRan = true;
  });
  assert.equal(routeRan, true, "M6 normalization failure alone must not latch TURN_STATE_UNCERTAIN");
});
