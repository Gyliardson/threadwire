import assert from "node:assert/strict";
import test from "node:test";
import { ChromeRemoteInterfaceTransport } from "../../src/cdp/ChromeRemoteInterfaceTransport.js";
import {
  CdpNavigationSettlementTransportSession,
  CdpProjectUiTransportSession,
  CdpTurnTransportSession,
} from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { createProjectLocator, createProjectName } from "../../src/domain/ProjectIdentity.js";
import { createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import { RuntimeProvenanceUnverifiedError } from "../../src/domain/errors.js";

const target: CdpTargetInfo = {
  id: "bound-composite-target",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/bound-composite-target",
  url: "https://chatgpt.com/",
};
const projectLocator = createProjectLocator(
  "https://chatgpt.com/g/g-p-00000000000000000000000000000002/project",
);
const conversationLocator = createConversationLocator("https://chatgpt.com/c/synthetic-bound");

type ConnectedSession = CdpTurnTransportSession &
  CdpProjectUiTransportSession &
  CdpNavigationSettlementTransportSession;

class CompositeCriClient {
  public frameUrl: string = projectLocator;
  public provenanceValid = true;
  public pageNavigateCalls = 0;
  public readonly inputCalls: string[] = [];
  public readonly evaluateCalls: string[] = [];
  public readonly callFunctionCalls: Array<Readonly<Record<string, unknown>>> = [];
  public readonly callFunctionResults: unknown[] = [];
  public onGetFrameTree: (() => void) | null = null;
  public onPageEnable: (() => void) | null = null;
  public onCallFunction: ((index: number) => void) | null = null;
  private readonly disconnectListeners = new Set<() => void>();

  public readonly Page = {
    enable: async () => {
      this.onPageEnable?.();
    },
    navigate: async (_params: { url: string }) => {
      this.pageNavigateCalls += 1;
      return { frameId: "main" };
    },
    reload: async (_params: { ignoreCache?: boolean } = {}) => undefined,
    getFrameTree: async () => {
      const result = {
        frameTree: {
          frame: { id: "main", loaderId: "loader", url: this.frameUrl },
        },
      };
      this.onGetFrameTree?.();
      return result;
    },
    loadEventFired: (_listener: () => void) => () => undefined,
    frameStoppedLoading: (_listener: (event: { frameId?: string }) => void) => () => undefined,
  };

  public readonly Accessibility = {
    getFullAXTree: async () => ({ nodes: [] }),
  };

  public readonly DOM = {
    focus: async (_params: { backendNodeId: number }) => undefined,
    resolveNode: async ({ backendNodeId }: { backendNodeId: number }) => ({
      object: { objectId: backendNodeId === 501 ? "composer-501" : `form-${backendNodeId}` },
    }),
    describeNode: async ({ objectId }: { objectId: string }) => ({
      node: { backendNodeId: Number(objectId.replace("form-", "")) },
    }),
  };

  public readonly Input = {
    insertText: async ({ text }: { text: string }) => {
      this.inputCalls.push(`insert:${text}`);
    },
    dispatchKeyEvent: async ({ type }: { type: string }) => {
      this.inputCalls.push(`key:${type}`);
    },
  };

  public readonly Runtime = {
    evaluate: async ({ expression }: { expression: string; returnByValue?: boolean }) => {
      this.evaluateCalls.push(expression);
      return { result: { value: true } };
    },
    callFunctionOn: async (params: Readonly<Record<string, unknown>>) => {
      const index = this.callFunctionCalls.length;
      this.callFunctionCalls.push(params);
      const configured = this.callFunctionResults.shift();
      this.onCallFunction?.(index);
      if (typeof configured === "object" && configured !== null && "objectId" in configured) {
        return { result: configured };
      }
      return { result: { value: configured } };
    },
    releaseObject: async (_params: { objectId: string }) => undefined,
  };

  public readonly Network = {
    enable: async (_options: Record<string, unknown>) => undefined,
    requestWillBeSent: (_listener: (event: never) => void) => () => undefined,
    responseReceived: (_listener: (event: never) => void) => () => undefined,
    loadingFinished: (_listener: (event: never) => void) => () => undefined,
    loadingFailed: (_listener: (event: never) => void) => () => undefined,
  };

  public async close(): Promise<void> {}

  public on(event: "disconnect", listener: () => void): void {
    if (event === "disconnect") this.disconnectListeners.add(listener);
  }
}

async function connect(client: CompositeCriClient): Promise<ConnectedSession> {
  const transport = new ChromeRemoteInterfaceTransport({ connect: async () => client });
  const session = await transport.connect({
    host: "127.0.0.1",
    port: 9223,
    target,
    beforeMutation: async () => {
      if (!client.provenanceValid) throw new RuntimeProvenanceUnverifiedError();
    },
  }) as ConnectedSession;
  await session.initializeReadinessObservation();
  return session;
}

test("production raw mutation hook blocks Project composer Input.insertText after observation drift", async () => {
  const client = new CompositeCriClient();
  client.callFunctionResults.push({ objectId: "form-601" }, true);
  client.onCallFunction = (index) => {
    if (index === 1) client.provenanceValid = false;
  };
  const session = await connect(client);

  await assert.rejects(
    session.insertTextIntoProjectComposer!("synthetic", projectLocator, 501),
  );

  assert.deepEqual(client.inputCalls, []);
  assert.equal(client.callFunctionCalls.length, 2);
});

test("production raw mutation hook blocks Project send click after async validation drift", async () => {
  const client = new CompositeCriClient();
  client.callFunctionResults.push({ kind: "TEXT_CONTROL_EXACT" });
  client.onCallFunction = (index) => {
    if (index === 0) client.provenanceValid = false;
  };
  const session = await connect(client);

  await assert.rejects(
    session.clickTurnSendButton!(projectLocator, 501, 601, "synthetic"),
  );

  assert.equal(client.callFunctionCalls.length, 1);
  assert.equal(
    client.callFunctionCalls.some((call) => String(call.functionDeclaration).includes("matches[0].click")),
    false,
  );
});

test("production raw mutation hook blocks existing-thread send click after validation drift", async () => {
  const client = new CompositeCriClient();
  client.frameUrl = conversationLocator;
  client.callFunctionResults.push(
    { objectId: "form-601" },
    { kind: "TEXT_CONTROL_EXACT" },
  );
  client.onCallFunction = (index) => {
    if (index === 1) client.provenanceValid = false;
  };
  const session = await connect(client);

  await assert.rejects(
    session.clickExistingTurnSendButton!(conversationLocator, 501, "synthetic"),
  );

  assert.equal(client.callFunctionCalls.length, 2);
  assert.equal(
    client.callFunctionCalls.some((call) => String(call.functionDeclaration).includes("matches[0].click")),
    false,
  );
});

test("production raw mutation hook blocks Project creation before first UI mutation after route observation", async () => {
  const client = new CompositeCriClient();
  client.frameUrl = "https://chatgpt.com/";
  client.onGetFrameTree = () => {
    client.provenanceValid = false;
    client.onGetFrameTree = null;
  };
  const session = await connect(client);

  await assert.rejects(
    session.createProjectThroughUi(createProjectName("Synthetic")),
  );

  assert.deepEqual(client.evaluateCalls, []);
  assert.deepEqual(client.inputCalls, []);
});

test("production raw mutation hook blocks Page.navigate after navigation setup drift", async () => {
  const client = new CompositeCriClient();
  client.onPageEnable = () => {
    client.provenanceValid = false;
  };
  const session = await connect(client);

  await assert.rejects(
    session.navigateAndWaitForLoadSettlement(
      "https://chatgpt.com/",
      { kind: "FRESH_ROOT" },
    ),
  );

  assert.equal(client.pageNavigateCalls, 0);
});
