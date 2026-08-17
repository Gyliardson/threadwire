import assert from "node:assert/strict";
import test from "node:test";
import {
  CdpTurnComposerState,
  CdpTurnObservationHandle,
  CdpTurnObservationSnapshot,
} from "../../src/cdp/CdpTransport.js";
import {
  RuntimeGenerationTracker,
  RuntimeLease,
} from "../../src/domain/RuntimeGeneration.js";
import { OperationAbortedError } from "../../src/domain/errors.js";
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

const observationHandle = Object.freeze({}) as unknown as CdpTurnObservationHandle;

class NoopPreflight implements TurnComposerPreflightPort {
  public async waitForTurnComposer(
    _expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<void> {}
}

class BlockingCompositionCdp implements TurnCdpPort {
  public readonly insertReached = deferred<void>();
  public readonly releaseInsert = deferred<void>();
  public keyDownCalls = 0;
  public keyUpCalls = 0;
  public observationReads = 0;

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
    return observationHandle;
  }

  public getTurnObservation(
    _handle: CdpTurnObservationHandle,
    lease: RuntimeLease,
  ): CdpTurnObservationSnapshot {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.observationReads += 1;
    return Object.freeze({ prepareCount: 0, write: null });
  }

  public releaseTurnObservation(_handle: CdpTurnObservationHandle): void {}

  public async insertText(_text: string, lease: RuntimeLease): Promise<void> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.insertReached.resolve();
    await this.releaseInsert.promise;
    this.runtime.assertRuntimeLeaseCurrent(lease);
  }

  public async dispatchEnterKeyDown(_lease: RuntimeLease): Promise<void> {
    this.keyDownCalls += 1;
  }

  public async dispatchEnterKeyUp(_lease: RuntimeLease): Promise<void> {
    this.keyUpCalls += 1;
  }

  public async getCurrentConversationLocator(
    _lease: RuntimeLease,
  ): Promise<ConversationLocator | null> {
    return null;
  }
}

test("abort while successful composition is completing releases an already queued ROUTE without Enter or write assumptions", async () => {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 100, creationTime: "runtime-a" });
  const scheduler = new OperationScheduler(runtime);
  const registry = new ThreadRegistry({ handleFactory: () => "abort_boundary" });
  const locator = createConversationLocator("https://chatgpt.com/c/m5-abort-boundary");
  const handle = registry.register(locator);
  const cdp = new BlockingCompositionCdp(runtime);
  const executor = new TurnExecutor(registry, scheduler, new NoopPreflight(), cdp, {
    commandTimeoutMs: 100,
    writeObservationTimeoutMs: 10,
    writeSettlementTimeoutMs: 10,
    freshConversationTimeoutMs: 10,
    pollIntervalMs: 1,
    sleep: async () => undefined,
  });
  const abort = new AbortController();

  const turn = executor.execute(
    { kind: "THREAD", threadHandle: handle },
    "synthetic prompt",
    abort.signal,
  );
  await cdp.insertReached.promise;

  abort.abort(new Error("cancel before submit boundary"));
  let routeRan = false;
  const route = scheduler.schedule("ROUTE", async () => {
    routeRan = true;
  });
  await Promise.resolve();
  assert.equal(routeRan, false, "ROUTE remains serialized while composition call is still returning");

  cdp.releaseInsert.resolve();
  await assert.rejects(turn, OperationAbortedError);
  await route;

  assert.equal(routeRan, true);
  assert.equal(cdp.keyDownCalls, 0);
  assert.equal(cdp.keyUpCalls, 0);
  assert.equal(cdp.observationReads, 1, "pre-submit safety check proves that no write was observed");
});
