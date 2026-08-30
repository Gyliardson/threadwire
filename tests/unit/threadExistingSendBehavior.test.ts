import assert from "node:assert/strict";
import test from "node:test";
import {
  CdpTurnComposerState,
  CdpTurnObservationHandle,
  CdpTurnObservationSnapshot,
} from "../../src/cdp/CdpTransport.js";
import { RuntimeGenerationTracker, RuntimeLease } from "../../src/domain/RuntimeGeneration.js";
import { ConversationLocator, createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import { RouteExpectation } from "../../src/readiness/types.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";
import { ThreadRegistry } from "../../src/routing/ThreadRegistry.js";
import { TurnExecutor } from "../../src/turn/TurnExecutor.js";
import { TurnCdpPort, TurnComposerPreflightPort } from "../../src/turn/types.js";

const handle = Object.freeze({}) as unknown as CdpTurnObservationHandle;
const locator = createConversationLocator("https://chatgpt.com/c/thread-send-behavior");

class Preflight implements TurnComposerPreflightPort {
  public async waitForTurnComposer(
    _expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<void> {}
}

class Cdp implements TurnCdpPort {
  public inserted = false;
  public submitted = false;
  public sendCalls = 0;
  public enterDownCalls = 0;
  public enterUpCalls = 0;

  public constructor(private readonly runtime: RuntimeGenerationTracker) {}

  public async getTurnComposerState(
    _expectedRoute: RouteExpectation,
    lease: RuntimeLease,
  ): Promise<CdpTurnComposerState> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    return Object.freeze({
      expectedRoute: true,
      eligible: true,
      focused: true,
      empty: !this.inserted,
      backendDOMNodeId: 501,
    });
  }

  public armTurnObservation(lease: RuntimeLease): CdpTurnObservationHandle {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    return handle;
  }

  public getTurnObservation(
    _handle: CdpTurnObservationHandle,
    lease: RuntimeLease,
  ): CdpTurnObservationSnapshot {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    return Object.freeze({
      prepareCount: 0,
      write: this.submitted ? Object.freeze({ lifecycle: "FINISHED" as const }) : null,
    });
  }

  public releaseTurnObservation(_handle: CdpTurnObservationHandle): void {}

  public async insertText(_text: string, lease: RuntimeLease): Promise<void> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.inserted = true;
  }

  public async clickExistingTurnSendButton(
    conversationLocator: ConversationLocator,
    backendDOMNodeId: number,
    expectedText: string,
    lease: RuntimeLease,
  ): Promise<void> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    assert.equal(conversationLocator, locator);
    assert.equal(backendDOMNodeId, 501);
    assert.equal(expectedText, "behavior prompt");
    this.sendCalls += 1;
    this.submitted = true;
  }

  public async dispatchEnterKeyDown(lease: RuntimeLease): Promise<void> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.enterDownCalls += 1;
    this.submitted = true;
  }

  public async dispatchEnterKeyUp(lease: RuntimeLease): Promise<void> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.enterUpCalls += 1;
  }

  public async getCurrentConversationLocator(lease: RuntimeLease): Promise<ConversationLocator | null> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    return locator;
  }
}

function fixture(): {
  executor: TurnExecutor;
  cdp: Cdp;
  registry: ThreadRegistry;
} {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 100, creationTime: "runtime-a" });
  const scheduler = new OperationScheduler(runtime);
  const registry = new ThreadRegistry({ handleFactory: () => "thread_send_behavior" });
  const cdp = new Cdp(runtime);
  const executor = new TurnExecutor(registry, scheduler, new Preflight(), cdp, {
    commandTimeoutMs: 100,
    writeObservationTimeoutMs: 20,
    writeSettlementTimeoutMs: 20,
    freshConversationTimeoutMs: 20,
    pollIntervalMs: 1,
    sleep: async () => undefined,
  });
  return { executor, cdp, registry };
}

test("THREAD submits through validated existing-thread Send and never Enter", async () => {
  const { executor, cdp, registry } = fixture();
  const threadHandle = registry.register(locator);
  await executor.execute({ kind: "THREAD", threadHandle }, "behavior prompt");
  assert.equal(cdp.sendCalls, 1);
  assert.equal(cdp.enterDownCalls, 0);
  assert.equal(cdp.enterUpCalls, 0);
});

test("FRESH retains Enter submission and never existing-thread Send", async () => {
  const { executor, cdp } = fixture();
  await executor.execute({ kind: "FRESH" }, "behavior prompt");
  assert.equal(cdp.sendCalls, 0);
  assert.equal(cdp.enterDownCalls, 1);
  assert.equal(cdp.enterUpCalls, 1);
});
