import assert from "node:assert/strict";
import test from "node:test";
import { CdpSessionManager, CdpTargetDiscoveryLike } from "../../src/cdp/CdpSessionManager.js";
import {
  CdpTransport,
  CdpTransportConnectOptions,
  CdpTurnObservationHandle,
  CdpTurnTransportSession,
} from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { RuntimeGenerationTracker } from "../../src/domain/RuntimeGeneration.js";
import {
  CdpDisconnectedError,
  RuntimeGenerationChangedError,
} from "../../src/domain/errors.js";
import { createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import { ExistingReadinessSnapshot, RouteExpectation } from "../../src/readiness/types.js";

const config = { cdpHost: "127.0.0.1" as const, cdpPort: 9223 };
const target: CdpTargetInfo = {
  id: "target-turn",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/target-turn",
  url: "https://chatgpt.com/c/synthetic-turn",
};
const locator = createConversationLocator("https://chatgpt.com/c/synthetic-turn");
const observationHandle = Object.freeze({}) as unknown as CdpTurnObservationHandle;

class Discovery implements CdpTargetDiscoveryLike {
  public async findPrimaryTarget(): Promise<CdpTargetInfo> {
    return target;
  }
}

class FakeTurnSession implements CdpTurnTransportSession {
  public readonly events: string[] = [];
  public insertCalls = 0;
  private readonly disconnectListeners = new Set<() => void>();

  public async close(): Promise<void> {}

  public onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  public async initializeReadinessObservation(): Promise<void> {
    this.events.push("initialize");
  }

  public async navigate(_url: string): Promise<void> {
    this.events.push("navigate");
  }

  public async reload(): Promise<void> {
    this.events.push("reload");
  }

  public async getReadinessSnapshot(
    _expectedRoute: RouteExpectation,
  ): Promise<ExistingReadinessSnapshot> {
    return {
      mainFrame: { frameId: "main", loaderId: "loader", expectedRoute: true },
      eligibleEditables: [{ backendDOMNodeId: 101, focused: true }],
      backendActivity: { activeCount: 0, activityEpoch: 1 },
    };
  }

  public async focusBackendNode(_backendDOMNodeId: number): Promise<void> {}

  public async getTurnComposerState(_expectedRoute: RouteExpectation) {
    this.events.push("composer");
    return Object.freeze({ expectedRoute: true, eligible: true, focused: true, empty: true });
  }

  public armTurnObservation(): CdpTurnObservationHandle {
    this.events.push("arm");
    return observationHandle;
  }

  public getTurnObservation(_handle: CdpTurnObservationHandle) {
    this.events.push("observe");
    return Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "ACTIVE" as const }),
    });
  }

  public releaseTurnObservation(_handle: CdpTurnObservationHandle): void {
    this.events.push("release");
  }

  public async insertText(_text: string): Promise<void> {
    this.insertCalls += 1;
    this.events.push("insert");
  }

  public async dispatchEnterKeyDown(): Promise<void> {
    this.events.push("down");
  }

  public async dispatchEnterKeyUp(): Promise<void> {
    this.events.push("up");
  }

  public async getCurrentConversationLocator() {
    this.events.push("locator");
    return locator;
  }

  public emitDisconnect(): void {
    for (const listener of [...this.disconnectListeners]) {
      listener();
    }
  }
}

class Transport implements CdpTransport {
  public readonly session = new FakeTurnSession();

  public async connect(_options: CdpTransportConnectOptions): Promise<CdpTurnTransportSession> {
    return this.session;
  }
}

function createRuntime(): RuntimeGenerationTracker {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 100, creationTime: "runtime-a" });
  return runtime;
}

test("manager delegates typed M5 primitives only for the scheduler-provided current lease", async () => {
  const runtime = createRuntime();
  const transport = new Transport();
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new Discovery(),
    transport,
    attachTimeoutMs: 100,
  });
  await manager.connect();
  const lease = runtime.getCurrentRuntimeLease();
  const expectedRoute: RouteExpectation = { kind: "THREAD", locator };

  assert.deepEqual(await manager.getTurnComposerState(expectedRoute, lease), {
    expectedRoute: true,
    eligible: true,
    focused: true,
    empty: true,
  });
  const handle = manager.armTurnObservation(lease);
  await manager.insertText("PROMPT_TEXT_SECRET", lease);
  await manager.dispatchEnterKeyDown(lease);
  await manager.dispatchEnterKeyUp(lease);
  assert.equal(manager.getTurnObservation(handle, lease).write?.lifecycle, "ACTIVE");
  assert.equal(await manager.getCurrentConversationLocator(lease), locator);
  manager.releaseTurnObservation(handle);

  assert.deepEqual(transport.session.events, [
    "initialize",
    "composer",
    "arm",
    "insert",
    "down",
    "up",
    "observe",
    "locator",
    "release",
  ]);
});

test("runtime replacement before input rejects without invoking the old session mutation", async () => {
  const runtime = createRuntime();
  const transport = new Transport();
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new Discovery(),
    transport,
    attachTimeoutMs: 100,
  });
  await manager.connect();
  const oldLease = runtime.getCurrentRuntimeLease();
  runtime.observe({ pid: 200, creationTime: "runtime-b" });

  await assert.rejects(
    () => manager.insertText("PROMPT_TEXT_SECRET", oldLease),
    RuntimeGenerationChangedError,
  );
  assert.equal(transport.session.insertCalls, 0);
});

test("same-generation disconnect prevents later M5 input delegation", async () => {
  const runtime = createRuntime();
  const transport = new Transport();
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new Discovery(),
    transport,
    attachTimeoutMs: 100,
  });
  await manager.connect();
  const lease = runtime.getCurrentRuntimeLease();
  transport.session.emitDisconnect();

  await assert.rejects(
    () => manager.insertText("PROMPT_TEXT_SECRET", lease),
    CdpDisconnectedError,
  );
  assert.equal(transport.session.insertCalls, 0);
});
