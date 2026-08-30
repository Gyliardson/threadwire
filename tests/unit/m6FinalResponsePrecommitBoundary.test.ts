import assert from "node:assert/strict";
import test from "node:test";
import {
  CdpTurnComposerState,
  CdpTurnObservationHandle,
  CdpTurnObservationSnapshot,
} from "../../src/cdp/CdpTransport.js";
import { RuntimeGenerationTracker, RuntimeLease } from "../../src/domain/RuntimeGeneration.js";
import { TurnStateUncertainError } from "../../src/domain/errors.js";
import { createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import { RouteExpectation } from "../../src/readiness/types.js";
import { NormalizedResponseStreamEvent } from "../../src/response/types.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";
import { ThreadRegistry } from "../../src/routing/ThreadRegistry.js";
import { TurnExecutor } from "../../src/turn/TurnExecutor.js";
import { TurnCdpPort, TurnComposerPreflightPort } from "../../src/turn/types.js";

const handle = Object.freeze({}) as unknown as CdpTurnObservationHandle;

class NoopPreflight implements TurnComposerPreflightPort {
  public async waitForTurnComposer(
    _expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<void> {}
}

class BaselineRacePort implements TurnCdpPort {
  public armed = false;
  public insertCalls = 0;
  public released = false;
  private snapshot: CdpTurnObservationSnapshot = Object.freeze({
    prepareCount: 0,
    write: null,
    response: Object.freeze({ lifecycle: "PENDING" as const, failure: null }),
  });

  public async getTurnComposerState(
    _expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
  ): Promise<CdpTurnComposerState> {
    return { expectedRoute: true, eligible: true, focused: true, backendDOMNodeId: 101, empty: true };
  }

  public armTurnObservation(): CdpTurnObservationHandle {
    this.armed = true;
    this.snapshot = Object.freeze({
      prepareCount: 0,
      write: Object.freeze({ lifecycle: "ACTIVE" as const }),
      response: Object.freeze({ lifecycle: "PENDING" as const, failure: null }),
    });
    return handle;
  }

  public getTurnObservation(): CdpTurnObservationSnapshot {
    return this.snapshot;
  }

  public takeTurnResponseEvents(): readonly NormalizedResponseStreamEvent[] {
    return [];
  }

  public discardTurnResponse(): void {}

  public releaseTurnObservation(): void {
    this.released = true;
  }

  public async insertText(): Promise<void> {
    this.insertCalls += 1;
  }

  public async clickExistingTurnSendButton(): Promise<void> {
    throw new Error("existing-thread Send must not run after a pre-submit write");
  }

  public async dispatchEnterKeyDown(): Promise<void> {}
  public async dispatchEnterKeyUp(): Promise<void> {}
  public async getCurrentConversationLocator() {
    return null;
  }
}

test("write observed before input mutation fails closed before composer insertion", async () => {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 800, creationTime: "baseline-race" });
  const scheduler = new OperationScheduler(runtime);
  const registry = new ThreadRegistry({ handleFactory: () => "baseline_race_handle" });
  const locator = createConversationLocator("https://chatgpt.com/c/baseline-race");
  const threadHandle = registry.register(locator);
  const port = new BaselineRacePort();
  const executor = new TurnExecutor(registry, scheduler, new NoopPreflight(), port, {
    commandTimeoutMs: 100,
    writeObservationTimeoutMs: 100,
    writeSettlementTimeoutMs: 100,
    responseCompletionTimeoutMs: 100,
    freshConversationTimeoutMs: 100,
    pollIntervalMs: 1,
  });

  await assert.rejects(
    executor.executeStreaming(
      { kind: "THREAD", threadHandle },
      "synthetic prompt",
      () => undefined,
    ),
    TurnStateUncertainError,
  );
  assert.equal(port.insertCalls, 0);
  assert.equal(port.released, true);

  let routeRan = false;
  await assert.rejects(
    () => scheduler.schedule("ROUTE", async () => {
      routeRan = true;
    }),
    TurnStateUncertainError,
  );
  assert.equal(routeRan, false);
});
