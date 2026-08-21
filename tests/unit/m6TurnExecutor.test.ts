import assert from "node:assert/strict";
import test from "node:test";
import {
  CdpTurnComposerState,
  CdpTurnObservationHandle,
  CdpTurnObservationOptions,
  CdpTurnObservationSnapshot,
} from "../../src/cdp/CdpTransport.js";
import { RuntimeGenerationTracker, RuntimeLease } from "../../src/domain/RuntimeGeneration.js";
import { createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import {
  OperationAbortedError,
  ResponseParseFailedError,
  RuntimeGenerationChangedError,
  ResponseStreamUnavailableError,
  TurnWriteFailedError,
} from "../../src/domain/errors.js";
import { RouteExpectation } from "../../src/readiness/types.js";
import { ResponseStreamEvent } from "../../src/response/types.js";
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
  public readonly responseEvents: ResponseStreamEvent[] = [];
  public keyDownAction: (() => void) | null = null;
  public armOptions: CdpTurnObservationOptions | undefined;
  public discarded = false;
  public released = false;
  public runtime: RuntimeGenerationTracker | null = null;

  public async getTurnComposerState(
    _expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
  ): Promise<CdpTurnComposerState> {
    return { expectedRoute: true, eligible: true, focused: true, empty: true };
  }
  public armTurnObservation(
    _lease: RuntimeLease,
    options?: CdpTurnObservationOptions,
  ): CdpTurnObservationHandle {
    this.armOptions = options;
    return this.observationHandle;
  }
  public getTurnObservation(
    _handle: CdpTurnObservationHandle,
    _lease: RuntimeLease,
  ): CdpTurnObservationSnapshot {
    this.runtime?.assertRuntimeLeaseCurrent(_lease);
    return this.snapshot;
  }
  public takeTurnResponseEvents(
    _handle: CdpTurnObservationHandle,
    _lease: RuntimeLease,
  ): readonly ResponseStreamEvent[] {
    return this.responseEvents.splice(0, this.responseEvents.length);
  }
  public discardTurnResponse(_handle: CdpTurnObservationHandle, _lease: RuntimeLease): void {
    this.discarded = true;
    this.responseEvents.splice(0, this.responseEvents.length);
  }
  public releaseTurnObservation(_handle: CdpTurnObservationHandle): void {
    this.released = true;
  }
  public async insertText(_text: string, _lease: RuntimeLease): Promise<void> {}
  public async dispatchEnterKeyDown(_lease: RuntimeLease): Promise<void> {
    this.keyDownAction?.();
  }
  public async dispatchEnterKeyUp(_lease: RuntimeLease): Promise<void> {}
  public async getCurrentConversationLocator(_lease: RuntimeLease) {
    return null;
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
    freshConversationTimeoutMs: 100,
    pollIntervalMs: 1,
    sleep: sleep.sleep,
  });
  return { scheduler, registry, handle, port, sleep, executor };
}

test("executeStreaming arms response observation before commit and delivers normalized events while retaining TURN through settlement", async () => {
  const f = await fixture();
  const delivered: ResponseStreamEvent[] = [];
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "ACTIVE" as const }),
      response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
    });
    f.port.responseEvents.push(
      Object.freeze({ type: "TEXT_DELTA" as const, text: "hello" }),
      Object.freeze({ type: "COMPLETED" as const }),
    );
  };

  const turn = f.executor.executeStreaming(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
    (event) => delivered.push(event),
  );
  const isSettled = settledState(turn);
  await f.sleep.entered.promise;
  assert.deepEqual(f.port.armOptions, { responseStream: true });
  assert.deepEqual(delivered, [
    { type: "TEXT_DELTA", text: "hello" },
    { type: "COMPLETED" },
  ]);
  assert.equal(isSettled(), false, "semantic completion must not redefine M5 transport settlement");

  let routeRan = false;
  const route = f.scheduler.schedule("ROUTE", async () => {
    routeRan = true;
  });
  await Promise.resolve();
  assert.equal(routeRan, false, "TURN ownership must remain held after [DONE] while write transport is active");

  f.port.snapshot = Object.freeze({
    prepareCount: 1,
    write: Object.freeze({ lifecycle: "FINISHED" as const }),
    response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
  });
  f.sleep.release.resolve();
  const result = await turn;
  await route;
  assert.equal(result.created, false);
  assert.equal(routeRan, true);
  assert.equal(f.port.released, true);
});

test("M6 parse failure waits for safe M5 settlement and does not latch TURN_STATE_UNCERTAIN", async () => {
  const f = await fixture();
  const delivered: ResponseStreamEvent[] = [];
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "ACTIVE" as const }),
      response: Object.freeze({ lifecycle: "FAILED" as const, failure: "PARSE_FAILED" as const }),
    });
    f.port.responseEvents.push(Object.freeze({ type: "TEXT_DELTA" as const, text: "valid-prefix" }));
  };
  const turn = f.executor.executeStreaming(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
    (event) => delivered.push(event),
  );
  const isSettled = settledState(turn);
  await f.sleep.entered.promise;
  assert.equal(isSettled(), false, "normalization failure must not abandon active write safety observation");
  assert.deepEqual(delivered, [{ type: "TEXT_DELTA", text: "valid-prefix" }]);
  assert.equal(f.port.discarded, true);

  f.port.snapshot = Object.freeze({
    prepareCount: 1,
    write: Object.freeze({ lifecycle: "FINISHED" as const }),
    response: Object.freeze({ lifecycle: "FAILED" as const, failure: "PARSE_FAILED" as const }),
  });
  f.sleep.release.resolve();
  await assert.rejects(turn, ResponseParseFailedError);

  let routeRan = false;
  await f.scheduler.schedule("ROUTE", async () => {
    routeRan = true;
  });
  assert.equal(routeRan, true, "M6 parse failure must not poison scheduler mutation state");
});

test("M5 write failure dominates an M6 response failure", async () => {
  const f = await fixture();
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "FAILED" as const }),
      response: Object.freeze({ lifecycle: "FAILED" as const, failure: "PARSE_FAILED" as const }),
    });
  };
  await assert.rejects(
    f.executor.executeStreaming(
      { kind: "THREAD", threadHandle: f.handle },
      "synthetic prompt",
      () => undefined,
    ),
    TurnWriteFailedError,
  );
});

test("caller cancellation after Enter commit stops response delivery but retains M5 safety observation until settlement", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const delivered: ResponseStreamEvent[] = [];
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "ACTIVE" as const }),
      response: Object.freeze({ lifecycle: "STREAMING" as const, failure: null }),
    });
  };

  const turn = f.executor.executeStreaming(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
    (event) => delivered.push(event),
    abort.signal,
  );
  const isSettled = settledState(turn);
  await f.sleep.entered.promise;
  abort.abort(new Error("caller stopped waiting"));
  f.port.responseEvents.push(
    Object.freeze({ type: "TEXT_DELTA" as const, text: "must-not-deliver" }),
    Object.freeze({ type: "COMPLETED" as const }),
  );

  let routeRan = false;
  const route = f.scheduler.schedule("ROUTE", async () => {
    routeRan = true;
  });
  await Promise.resolve();
  assert.equal(routeRan, false);
  assert.equal(isSettled(), false);

  f.port.snapshot = Object.freeze({
    prepareCount: 1,
    write: Object.freeze({ lifecycle: "FINISHED" as const }),
    response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
  });
  f.sleep.release.resolve();
  await assert.rejects(turn, OperationAbortedError);
  await route;
  assert.deepEqual(delivered, []);
  assert.equal(f.port.discarded, true);
  assert.equal(routeRan, true);
});


test("runtime-generation replacement invalidates response work and releases the scoped observation", async () => {
  const f = await fixture();
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "ACTIVE" as const }),
      response: Object.freeze({ lifecycle: "STREAMING" as const, failure: null }),
    });
  };

  const turn = f.executor.executeStreaming(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
    () => undefined,
  );
  await f.sleep.entered.promise;
  f.port.runtime!.observe({ pid: 601, creationTime: "m6-turn-replaced" });
  f.port.responseEvents.push(Object.freeze({ type: "TEXT_DELTA" as const, text: "stale" }));
  f.sleep.release.resolve();

  await assert.rejects(turn, RuntimeGenerationChangedError);
  assert.equal(f.port.released, true, "finally must release and dispose the stale scoped response observation");
});

test("streaming is rejected before commit when the TurnCdpPort lacks the M6 response seam", async () => {
  const f = await fixture();
  const legacyPort: TurnCdpPort = {
    getTurnComposerState: f.port.getTurnComposerState.bind(f.port),
    armTurnObservation: f.port.armTurnObservation.bind(f.port),
    getTurnObservation: f.port.getTurnObservation.bind(f.port),
    releaseTurnObservation: f.port.releaseTurnObservation.bind(f.port),
    insertText: f.port.insertText.bind(f.port),
    dispatchEnterKeyDown: f.port.dispatchEnterKeyDown.bind(f.port),
    dispatchEnterKeyUp: f.port.dispatchEnterKeyUp.bind(f.port),
    getCurrentConversationLocator: f.port.getCurrentConversationLocator.bind(f.port),
  };
  const executor = new TurnExecutor(
    f.registry,
    f.scheduler,
    new NoopPreflight(),
    legacyPort,
    { commandTimeoutMs: 100, writeObservationTimeoutMs: 100, writeSettlementTimeoutMs: 100 },
  );
  await assert.rejects(
    executor.executeStreaming(
      { kind: "THREAD", threadHandle: f.handle },
      "synthetic prompt",
      () => undefined,
    ),
    ResponseStreamUnavailableError,
  );
});
