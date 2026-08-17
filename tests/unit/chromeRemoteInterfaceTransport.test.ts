import assert from "node:assert/strict";
import test from "node:test";
import { ChromeRemoteInterfaceTransport } from "../../src/cdp/ChromeRemoteInterfaceTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { createConversationLocator } from "../../src/domain/ThreadIdentity.js";

const target: CdpTargetInfo = {
  id: "target-1", title: "ChatGPT", type: "page", description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/target-1",
  url: "https://chatgpt.com/c/synthetic-a",
};
const expected = createConversationLocator("https://chatgpt.com/c/synthetic-a");

type RequestListener = (event: { requestId: string; request: { url: string } }) => void;
type SettledListener = (event: { requestId: string }) => void;

class FakeCriClient {
  public readonly events: string[] = [];
  public closeCalls = 0;
  public frame = { id: "main", loaderId: "loader-a", url: "https://chatgpt.com/c/synthetic-a?locator_canary=secret" };
  public axNodes: readonly unknown[] = [
    {
      ignored: false,
      role: { value: "textbox" },
      name: { value: "ACCESSIBLE_TEXT_CANARY" },
      backendDOMNodeId: 101,
      properties: [
        { name: "multiline", value: { value: true } },
        { name: "focusable", value: { value: true } },
        { name: "editable", value: { value: "richtext" } },
        { name: "focused", value: { value: false } },
      ],
    },
  ];
  public readonly focusIds: number[] = [];
  private readonly disconnectListeners = new Set<() => void>();
  private readonly requestListeners = new Set<RequestListener>();
  private readonly finishedListeners = new Set<SettledListener>();
  private readonly failedListeners = new Set<SettledListener>();

  public readonly Page: {
    navigate(params: { url: string }): Promise<Record<string, never>>;
    getFrameTree(): Promise<{ frameTree: { frame: { id: string; loaderId: string; url: string } } }>;
  };

  public constructor() {
    this.Page = {
      navigate: async ({ url }: { url: string }) => { this.events.push(`navigate:${url}`); return {}; },
      getFrameTree: async () => ({ frameTree: { frame: this.frame } }),
    };
  }

  public readonly Accessibility = {
    getFullAXTree: async (_params: { frameId: string }) => ({ nodes: this.axNodes }),
  };

  public readonly DOM = {
    focus: async ({ backendNodeId }: { backendNodeId: number }) => { this.focusIds.push(backendNodeId); this.events.push("dom.focus"); },
  };

  public enableOptions: unknown[] = [];

  public readonly Network = {
    enable: async (options: Record<string, unknown>) => { this.enableOptions.push(options); this.events.push("network.enable"); },
    requestWillBeSent: (listener: RequestListener) => {
      this.events.push("subscribe.request"); this.requestListeners.add(listener); return () => this.requestListeners.delete(listener);
    },
    loadingFinished: (listener: SettledListener) => {
      this.events.push("subscribe.finished"); this.finishedListeners.add(listener); return () => this.finishedListeners.delete(listener);
    },
    loadingFailed: (listener: SettledListener) => {
      this.events.push("subscribe.failed"); this.failedListeners.add(listener); return () => this.failedListeners.delete(listener);
    },
  };

  public async close(): Promise<void> { this.closeCalls += 1; }
  public on(event: "disconnect", listener: () => void): void { if (event === "disconnect") this.disconnectListeners.add(listener); }
  public removeListener(event: "disconnect", listener: () => void): void { if (event === "disconnect") this.disconnectListeners.delete(listener); }
  public emitRequest(requestId: string, url: string): void { for (const listener of this.requestListeners) listener({ requestId, request: { url } }); }
  public emitFinished(requestId: string): void { for (const listener of this.finishedListeners) listener({ requestId }); }
  public emitFailed(requestId: string): void { for (const listener of this.failedListeners) listener({ requestId }); }
  public emitDisconnect(): void { for (const listener of [...this.disconnectListeners]) listener(); }
  public networkListenerCount(): number {
    return this.requestListeners.size + this.finishedListeners.size + this.failedListeners.size;
  }
}

async function createSession(client = new FakeCriClient()) {
  const transport = new ChromeRemoteInterfaceTransport({ connect: async () => client });
  const session = await transport.connect({ host: "127.0.0.1", port: 9223, target });
  return { client, session };
}

test("Network listeners and Network.enable are established before route navigation", async () => {
  const { client, session } = await createSession();
  await session.initializeReadinessObservation();
  await session.navigate(expected);
  assert.deepEqual(client.events.slice(0, 5), [
    "subscribe.request", "subscribe.finished", "subscribe.failed", "network.enable", `navigate:${expected}`,
  ]);
  assert.deepEqual(client.enableOptions, [{}]);
});

test("relevant backend request IDs are metadata-only and loadingFinished clears them", async () => {
  const { client, session } = await createSession(); await session.initializeReadinessObservation();
  client.emitRequest("req-1", "https://chatgpt.com/backend-api/models?authorization=QUERY_SECRET#fragment");
  const active = await session.getReadinessSnapshot(expected);
  assert.equal(active.backendActivity.activeCount, 1);
  assert.equal(JSON.stringify(active).includes("QUERY_SECRET"), false);
  client.emitFinished("req-1");
  const settled = await session.getReadinessSnapshot(expected);
  assert.equal(settled.backendActivity.activeCount, 0);
  assert.ok(settled.backendActivity.activityEpoch > active.backendActivity.activityEpoch);
});

test("loadingFailed clears relevant activity and ignored traffic never blocks", async () => {
  const { client, session } = await createSession(); await session.initializeReadinessObservation();
  client.emitRequest("ignored", "https://example.com/backend-api/ignored?secret=1");
  assert.equal((await session.getReadinessSnapshot(expected)).backendActivity.activeCount, 0);
  client.emitRequest("req-2", "https://chatgpt.com/backend-api/conversations");
  assert.equal((await session.getReadinessSnapshot(expected)).backendActivity.activeCount, 1);
  client.emitFailed("req-2");
  assert.equal((await session.getReadinessSnapshot(expected)).backendActivity.activeCount, 0);
});

test("main-frame route is normalized internally without exposing current URL or query", async () => {
  const { session } = await createSession(); await session.initializeReadinessObservation();
  const snapshot = await session.getReadinessSnapshot(expected);
  assert.equal(snapshot.mainFrame.expectedRoute, true);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("synthetic-a"), false);
  assert.equal(serialized.includes("locator_canary"), false);
});

test("wrong and transient main-frame routes are simply not ready", async () => {
  const { client, session } = await createSession(); await session.initializeReadinessObservation();
  client.frame = { id: "main", loaderId: "loader-a", url: "https://chatgpt.com/c/synthetic-other?secret=WRONG_ROUTE" };
  let snapshot = await session.getReadinessSnapshot(expected);
  assert.equal(snapshot.mainFrame.expectedRoute, false);
  assert.equal(JSON.stringify(snapshot).includes("WRONG_ROUTE"), false);
  client.frame = { id: "main", loaderId: "loader-b", url: "about:blank" };
  snapshot = await session.getReadinessSnapshot(expected);
  assert.equal(snapshot.mainFrame.expectedRoute, false);
});

test("Accessibility mapping retains only eligible state and omits accessible text", async () => {
  const { session } = await createSession(); await session.initializeReadinessObservation();
  const snapshot = await session.getReadinessSnapshot(expected);
  assert.deepEqual(snapshot.eligibleEditables, [{ backendDOMNodeId: 101, focused: false }]);
  assert.equal(JSON.stringify(snapshot).includes("ACCESSIBLE_TEXT_CANARY"), false);
});

test("Accessibility classification requires exactly the narrow multiline editable shape", async () => {
  const { client, session } = await createSession(); await session.initializeReadinessObservation();
  client.axNodes = [
    { ignored: false, role: { value: "textbox" }, backendDOMNodeId: 1, properties: [] },
    { ignored: false, role: { value: "button" }, backendDOMNodeId: 2, properties: [] },
  ];
  assert.deepEqual((await session.getReadinessSnapshot(expected)).eligibleEditables, []);
});

test("typed DOM.focus delegates with backendNodeId and no generic mutation surface", async () => {
  const { client, session } = await createSession(); await session.initializeReadinessObservation();
  await session.focusBackendNode(101);
  assert.deepEqual(client.focusIds, [101]);
  assert.equal("send" in session, false);
  assert.equal("reload" in session, false);
});

test("disconnect clears readiness request tracking/listeners and closes the observation lifecycle", async () => {
  const { client, session } = await createSession(); await session.initializeReadinessObservation();
  client.emitRequest("req-3", "https://chatgpt.com/backend-api/models");
  assert.equal((await session.getReadinessSnapshot(expected)).backendActivity.activeCount, 1);
  assert.equal(client.networkListenerCount(), 3);

  client.emitDisconnect();

  assert.equal(client.networkListenerCount(), 0);
  await assert.rejects(() => session.getReadinessSnapshot(expected));
  await assert.rejects(() => session.initializeReadinessObservation());
});
