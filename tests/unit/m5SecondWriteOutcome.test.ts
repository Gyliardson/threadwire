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
import { TurnWriteFailedError } from "../../src/domain/errors.js";
import { ConversationLocator, createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import { RouteExpectation } from "../../src/readiness/types.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";
import { ThreadRegistry } from "../../src/routing/ThreadRegistry.js";
import { TurnExecutor } from "../../src/turn/TurnExecutor.js";
import { TurnCdpPort, TurnComposerPreflightPort } from "../../src/turn/types.js";

type RequestListener = (event: {
  requestId: string;
  request: { url: string; method?: string };
}) => void;
type ResponseListener = (event: { requestId: string; response: { status: number } }) => void;
type SettledListener = (event: { requestId: string }) => void;

type WriteOutcomeMode = "SUCCESS" | "NON_2XX" | "MISSING_STATUS" | "LOADING_FAILED";

class WriteOutcomeCriClient {
  public mode: WriteOutcomeMode = "SUCCESS";
  public readonly frame = {
    id: "main",
    loaderId: "loader",
    url: "https://chatgpt.com/c/m5-write-outcome",
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
          backendDOMNodeId: 777,
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
      this.emitRequest("write-a");
      if (this.mode === "SUCCESS") {
        this.emitResponse("write-a", 200);
        this.emitFinished("write-a");
      } else if (this.mode === "NON_2XX") {
        this.emitResponse("write-a", 503);
        this.emitFinished("write-a");
      } else if (this.mode === "MISSING_STATUS") {
        this.emitFinished("write-a");
      } else {
        this.emitResponse("write-a", 200);
        this.emitFailed("write-a");
      }
    },
  };

  public async close(): Promise<void> {}

  public on(event: "disconnect", listener: () => void): void {
    if (event === "disconnect") {
      this.disconnectListeners.add(listener);
    }
  }

  private emitRequest(requestId: string): void {
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

  private emitResponse(requestId: string, status: number): void {
    for (const listener of this.responseListeners) {
      listener({ requestId, response: { status } });
    }
  }

  private emitFinished(requestId: string): void {
    for (const listener of this.finishedListeners) {
      listener({ requestId });
    }
  }

  private emitFailed(requestId: string): void {
    for (const listener of this.failedListeners) {
      listener({ requestId });
    }
  }
}

class NoopPreflight implements TurnComposerPreflightPort {
  public async waitForTurnComposer(
    _expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<void> {}
}

class SessionPort implements TurnCdpPort {
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
    return await this.session.getCurrentConversationLocator();
  }
}

const target: CdpTargetInfo = {
  id: "m5-write-outcome",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/m5-write-outcome",
  url: "https://chatgpt.com/c/m5-write-outcome",
};

async function fixture(mode: WriteOutcomeMode) {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 900, creationTime: "write-outcome-a" });
  const scheduler = new OperationScheduler(runtime);
  const registry = new ThreadRegistry({ handleFactory: () => "write_outcome_handle" });
  const locator = createConversationLocator("https://chatgpt.com/c/m5-write-outcome");
  const handle = registry.register(locator);
  const client = new WriteOutcomeCriClient();
  client.mode = mode;
  const transport = new ChromeRemoteInterfaceTransport({ connect: async () => client });
  const session = (await transport.connect({
    host: "127.0.0.1",
    port: 9223,
    target,
  })) as CdpTurnTransportSession;
  await session.initializeReadinessObservation();
  const executor = new TurnExecutor(registry, scheduler, new NoopPreflight(), new SessionPort(runtime, session), {
    commandTimeoutMs: 100,
    writeObservationTimeoutMs: 10,
    writeSettlementTimeoutMs: 10,
    freshConversationTimeoutMs: 10,
    pollIntervalMs: 1,
    sleep: async () => undefined,
  });
  return { executor, handle };
}

test("2xx response metadata plus loadingFinished produces successful existing-turn M5 outcome", async () => {
  const f = await fixture("SUCCESS");
  const result = await f.executor.execute(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
  );
  assert.deepEqual(result, { kind: "THREAD", threadHandle: f.handle, created: false });
});

for (const mode of ["NON_2XX", "MISSING_STATUS", "LOADING_FAILED"] as const) {
  test(`${mode} produces TURN_WRITE_FAILED instead of false success`, async () => {
    const f = await fixture(mode);
    await assert.rejects(
      () => f.executor.execute({ kind: "THREAD", threadHandle: f.handle }, "synthetic prompt"),
      TurnWriteFailedError,
    );
  });
}
