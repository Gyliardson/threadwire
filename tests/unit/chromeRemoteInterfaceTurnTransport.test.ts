import assert from "node:assert/strict";
import test from "node:test";
import { ChromeRemoteInterfaceTransport } from "../../src/cdp/ChromeRemoteInterfaceTransport.js";
import {
  CdpTurnTransportSession,
} from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import { RouteExpectation } from "../../src/readiness/types.js";

const target: CdpTargetInfo = {
  id: "target-turn",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/target-turn",
  url: "https://chatgpt.com/c/synthetic-turn",
};
const expectedRoute: RouteExpectation = {
  kind: "THREAD",
  locator: createConversationLocator("https://chatgpt.com/c/synthetic-turn"),
};

type RequestListener = (event: {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string> | undefined;
    postData: string | undefined;
  };
}) => void;
type SettledListener = (event: { requestId: string }) => void;

class FakeTurnCriClient {
  public frame = {
    id: "main",
    loaderId: "loader-turn",
    url: "https://chatgpt.com/c/synthetic-turn",
  };
  public axNodes: readonly unknown[] = [
    {
      ignored: false,
      role: { value: "textbox" },
      name: { value: "ACCESSIBLE_NAME_SECRET" },
      value: { value: "" },
      backendDOMNodeId: 501,
      properties: [
        { name: "multiline", value: { value: true } },
        { name: "focusable", value: { value: true } },
        { name: "editable", value: { value: "richtext" } },
        { name: "focused", value: { value: true } },
      ],
    },
  ];
  public readonly inputCalls: Array<Readonly<Record<string, unknown>>> = [];
  private readonly disconnectListeners = new Set<() => void>();
  private readonly requestListeners = new Set<RequestListener>();
  private readonly finishedListeners = new Set<SettledListener>();
  private readonly failedListeners = new Set<SettledListener>();

  public readonly Page = {
    navigate: async (_params: { url: string }) => ({}),
    getFrameTree: async () => ({ frameTree: { frame: this.frame } }),
  };

  public readonly Accessibility = {
    getFullAXTree: async (_params: { frameId: string }) => ({ nodes: this.axNodes }),
  };

  public readonly DOM = {
    focus: async (_params: { backendNodeId: number }) => undefined,
  };

  public readonly Input = {
    insertText: async (params: { text: string }) => {
      this.inputCalls.push(Object.freeze({ method: "insertText", ...params }));
    },
    dispatchKeyEvent: async (params: Record<string, unknown>) => {
      this.inputCalls.push(Object.freeze({ method: "dispatchKeyEvent", ...params }));
    },
  };

  public readonly Network = {
    enable: async (_options: Record<string, unknown>) => undefined,
    requestWillBeSent: (listener: RequestListener) => {
      this.requestListeners.add(listener);
      return () => this.requestListeners.delete(listener);
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

  public async close(): Promise<void> {}

  public on(event: "disconnect", listener: () => void): void {
    if (event === "disconnect") {
      this.disconnectListeners.add(listener);
    }
  }

  public emitRequest(
    requestId: string,
    url: string,
    method = "GET",
    extra: Readonly<Record<string, unknown>> = {},
  ): void {
    for (const listener of this.requestListeners) {
      listener({
        requestId,
        request: {
          url,
          method,
          headers: extra.headers as Record<string, string> | undefined,
          postData: extra.postData as string | undefined,
        },
      });
    }
  }

  public emitFinished(requestId: string): void {
    for (const listener of this.finishedListeners) {
      listener({ requestId });
    }
  }

  public emitFailed(requestId: string): void {
    for (const listener of this.failedListeners) {
      listener({ requestId });
    }
  }
}

async function createSession(client = new FakeTurnCriClient()): Promise<{
  client: FakeTurnCriClient;
  session: CdpTurnTransportSession;
}> {
  const transport = new ChromeRemoteInterfaceTransport({ connect: async () => client });
  const session = (await transport.connect({
    host: "127.0.0.1",
    port: 9223,
    target,
  })) as CdpTurnTransportSession;
  await session.initializeReadinessObservation();
  return { client, session };
}

test("turn composer state exposes route/eligible/focused/empty booleans only", async () => {
  const { client, session } = await createSession();
  const empty = await session.getTurnComposerState(expectedRoute);
  assert.deepEqual(empty, {
    expectedRoute: true,
    eligible: true,
    focused: true,
    empty: true,
  });
  assert.equal(JSON.stringify(empty).includes("ACCESSIBLE_NAME_SECRET"), false);

  client.axNodes = [
    {
      ignored: false,
      role: { value: "textbox" },
      name: { value: "ACCESSIBLE_NAME_SECRET" },
      value: { value: "ACCESSIBLE_VALUE_SECRET" },
      backendDOMNodeId: 501,
      properties: [
        { name: "multiline", value: { value: true } },
        { name: "focusable", value: { value: true } },
        { name: "editable", value: { value: "richtext" } },
        { name: "focused", value: { value: true } },
      ],
    },
  ];
  const nonEmpty = await session.getTurnComposerState(expectedRoute);
  assert.deepEqual(nonEmpty, {
    expectedRoute: true,
    eligible: true,
    focused: true,
    empty: false,
  });
  assert.equal(JSON.stringify(nonEmpty).includes("ACCESSIBLE_VALUE_SECRET"), false);

  client.frame.url = "https://chatgpt.com/c/synthetic-other";
  const drifted = await session.getTurnComposerState(expectedRoute);
  assert.equal(drifted.expectedRoute, false);
  assert.equal(JSON.stringify(drifted).includes("synthetic-other"), false);
});

test("typed Input primitives preserve insertText then Enter keyDown/keyUp ordering", async () => {
  const { client, session } = await createSession();
  await session.insertText("PROMPT_TEXT_SECRET");
  await session.dispatchEnterKeyDown();
  await session.dispatchEnterKeyUp();

  assert.deepEqual(client.inputCalls, [
    { method: "insertText", text: "PROMPT_TEXT_SECRET" },
    {
      method: "dispatchKeyEvent",
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    },
    {
      method: "dispatchKeyEvent",
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    },
  ]);
  assert.equal("send" in session, false);
  assert.equal("reload" in session, false);
  assert.equal("evaluate" in session, false);
  assert.equal("getResponseBody" in session, false);
  assert.equal("streamResourceContent" in session, false);
});

test("turn observer classifies metadata only, tracks prepare independently, and settles exact write", async () => {
  const { client, session } = await createSession();
  const handle = session.armTurnObservation();

  client.emitRequest(
    "ignored-request-id-secret",
    "https://chatgpt.com/backend-api/models?QUERY_SECRET=1",
    "GET",
    { headers: { authorization: "AUTH_SECRET" }, postData: "BODY_SECRET" },
  );
  client.emitRequest(
    "prepare-request-id-secret-1",
    "https://chatgpt.com/backend-api/f/conversation/prepare?QUERY_SECRET=1",
    "POST",
    { headers: { authorization: "AUTH_SECRET" }, postData: "BODY_SECRET" },
  );
  client.emitRequest(
    "prepare-request-id-secret-2",
    "https://chatgpt.com/backend-api/f/conversation/prepare",
    "POST",
  );
  client.emitRequest(
    "write-request-id-secret",
    "https://chatgpt.com/backend-api/f/conversation?QUERY_SECRET=1",
    "POST",
    { headers: { authorization: "AUTH_SECRET" }, postData: "BODY_SECRET" },
  );

  const active = session.getTurnObservation(handle);
  assert.equal(active.prepareCount, 2);
  assert.equal(active.write?.lifecycle, "ACTIVE");
  const serialized = JSON.stringify(active);
  for (const canary of [
    "QUERY_SECRET",
    "AUTH_SECRET",
    "BODY_SECRET",
    "write-request-id-secret",
    "prepare-request-id-secret",
  ]) {
    assert.equal(serialized.includes(canary), false);
  }

  client.emitFinished("write-request-id-secret");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "FINISHED");
  session.releaseTurnObservation(handle);
  assert.throws(() => session.getTurnObservation(handle));

  const failedHandle = session.armTurnObservation();
  client.emitRequest(
    "failed-write-id-secret",
    "https://chatgpt.com/backend-api/f/conversation",
    "POST",
  );
  client.emitFailed("failed-write-id-secret");
  assert.equal(session.getTurnObservation(failedHandle).write?.lifecycle, "FAILED");
});

test("current conversation route is parsed internally and query metadata is discarded", async () => {
  const { client, session } = await createSession();
  client.frame.url = "https://chatgpt.com/c/synthetic-route?ROUTE_QUERY_SECRET=1#fragment";
  const locator = await session.getCurrentConversationLocator();
  assert.equal(locator, "https://chatgpt.com/c/synthetic-route");
  assert.equal(locator?.includes("ROUTE_QUERY_SECRET"), false);

  client.frame.url = "https://chatgpt.com/";
  assert.equal(await session.getCurrentConversationLocator(), null);
});
