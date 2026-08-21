import assert from "node:assert/strict";
import test from "node:test";
import { CdpSessionManager, CdpTargetDiscoveryLike } from "../../src/cdp/CdpSessionManager.js";
import {
  CdpResponseRenderBaseline,
  CdpResponseTurnTransportSession,
  CdpTransport,
  CdpTransportConnectOptions,
  CdpTurnObservationHandle,
} from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { RuntimeGenerationTracker } from "../../src/domain/RuntimeGeneration.js";
import { RuntimeGenerationChangedError } from "../../src/domain/errors.js";
import { createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import { ExistingReadinessSnapshot, RouteExpectation } from "../../src/readiness/types.js";
import { NormalizedResponseStreamEvent } from "../../src/response/types.js";

const config = { cdpHost: "127.0.0.1" as const, cdpPort: 9223 };
const target: CdpTargetInfo = {
  id: "response-target",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/response-target",
  url: "https://chatgpt.com/c/response-target",
};
const locator = createConversationLocator(target.url);
const handle = Object.freeze({}) as unknown as CdpTurnObservationHandle;

class Discovery implements CdpTargetDiscoveryLike {
  public async findPrimaryTarget(): Promise<CdpTargetInfo> {
    return target;
  }
}

class FakeResponseSession implements CdpResponseTurnTransportSession {
  public baselineCalls = 0;
  public snapshotCalls = 0;
  public finalExpectedRoute: RouteExpectation | null = null;
  public readonly events: NormalizedResponseStreamEvent[] = [];
  private readonly disconnectListeners = new Set<() => void>();

  public async close(): Promise<void> {}
  public onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }
  public async initializeReadinessObservation(): Promise<void> {}
  public async navigate(_url: string): Promise<void> {}
  public async getReadinessSnapshot(
    _expectedRoute: RouteExpectation,
  ): Promise<ExistingReadinessSnapshot> {
    return {
      mainFrame: { frameId: "main", loaderId: "loader", expectedRoute: true },
      eligibleEditables: [],
      backendActivity: { activeCount: 0, activityEpoch: 0 },
    };
  }
  public async focusBackendNode(_backendDOMNodeId: number): Promise<void> {}
  public async getTurnComposerState(_expectedRoute: RouteExpectation) {
    return { expectedRoute: true, eligible: true, focused: true, empty: true };
  }
  public async captureTurnResponseRenderBaseline(): Promise<CdpResponseRenderBaseline> {
    this.baselineCalls += 1;
    return { userCount: 4, assistantCount: 4 };
  }
  public async getFinalRenderedAssistantSnapshot(
    _baseline: CdpResponseRenderBaseline,
    expectedRoute: RouteExpectation,
  ) {
    this.snapshotCalls += 1;
    this.finalExpectedRoute = expectedRoute;
    return { text: "authoritative-final" };
  }
  public armTurnObservation(): CdpTurnObservationHandle {
    return handle;
  }
  public getTurnObservation(_handle: CdpTurnObservationHandle) {
    return {
      prepareCount: 0,
      write: { lifecycle: "FINISHED" as const },
      response: { lifecycle: "COMPLETED" as const, failure: null },
    };
  }
  public takeTurnResponseEvents(_handle: CdpTurnObservationHandle) {
    return this.events.splice(0, this.events.length);
  }
  public discardTurnResponse(_handle: CdpTurnObservationHandle): void {
    this.events.splice(0, this.events.length);
  }
  public releaseTurnObservation(_handle: CdpTurnObservationHandle): void {}
  public async insertText(_text: string): Promise<void> {}
  public async dispatchEnterKeyDown(): Promise<void> {}
  public async dispatchEnterKeyUp(): Promise<void> {}
  public async getCurrentConversationLocator() {
    return locator;
  }
}

class Transport implements CdpTransport {
  public readonly session = new FakeResponseSession();
  public async connect(_options: CdpTransportConnectOptions): Promise<CdpResponseTurnTransportSession> {
    return this.session;
  }
}

function runtime(): RuntimeGenerationTracker {
  const result = new RuntimeGenerationTracker();
  result.observe({ pid: 700, creationTime: "response-runtime" });
  return result;
}

test("manager delegates rendered baseline and final snapshot only for the current runtime lease", async () => {
  const currentRuntime = runtime();
  const transport = new Transport();
  const manager = new CdpSessionManager(config, currentRuntime, {
    discovery: new Discovery(),
    transport,
    attachTimeoutMs: 100,
  });
  await manager.connect();
  const lease = currentRuntime.getCurrentRuntimeLease();
  const expectedRoute: RouteExpectation = { kind: "THREAD", locator };

  assert.deepEqual(await manager.captureTurnResponseRenderBaseline(lease), {
    userCount: 4,
    assistantCount: 4,
  });
  assert.deepEqual(
    await manager.getFinalRenderedAssistantSnapshot(
      { userCount: 4, assistantCount: 4 },
      expectedRoute,
      lease,
    ),
    { text: "authoritative-final" },
  );
  assert.equal(transport.session.baselineCalls, 1);
  assert.equal(transport.session.snapshotCalls, 1);
  assert.deepEqual(transport.session.finalExpectedRoute, expectedRoute);

  currentRuntime.observe({ pid: 701, creationTime: "replacement-runtime" });
  await assert.rejects(
    () => manager.captureTurnResponseRenderBaseline(lease),
    RuntimeGenerationChangedError,
  );
  await assert.rejects(
    () =>
      manager.getFinalRenderedAssistantSnapshot(
        { userCount: 4, assistantCount: 4 },
        expectedRoute,
        lease,
      ),
    RuntimeGenerationChangedError,
  );
  assert.equal(transport.session.baselineCalls, 1);
  assert.equal(transport.session.snapshotCalls, 1);
});
