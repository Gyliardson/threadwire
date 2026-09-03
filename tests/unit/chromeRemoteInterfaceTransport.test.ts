import assert from "node:assert/strict";
import test from "node:test";
import { ChromeRemoteInterfaceTransport } from "../../src/cdp/ChromeRemoteInterfaceTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import { OperationAbortedError, OperationTimeoutError } from "../../src/domain/errors.js";
import { withTimeout } from "../../src/utils/timeout.js";

const target: CdpTargetInfo = {
  id: "target-1", title: "ChatGPT", type: "page", description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/target-1",
  url: "https://chatgpt.com/c/synthetic-a",
};
const expected = createConversationLocator("https://chatgpt.com/c/synthetic-a");

type RequestListener = (event: { requestId: string; request: { url: string; method?: string } }) => void;
type ResponseListener = (event: { requestId: string; response: { status: number } }) => void;
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
  public readonly reloadOptions: Array<{ ignoreCache?: boolean }> = [];
  private readonly disconnectListeners = new Set<() => void>();
  private readonly requestListeners = new Set<RequestListener>();
  private readonly responseListeners = new Set<ResponseListener>();
  private readonly finishedListeners = new Set<SettledListener>();
  private readonly failedListeners = new Set<SettledListener>();

  public readonly Page: {
    navigate(params: { url: string }): Promise<Record<string, never>>;
    reload(params?: { ignoreCache?: boolean }): Promise<void>;
    getFrameTree(): Promise<{ frameTree: { frame: { id: string; loaderId: string; url: string } } }>;
  };

  public constructor() {
    this.Page = {
      navigate: async ({ url }: { url: string }) => { this.events.push(`navigate:${url}`); return {}; },
      reload: async (params: { ignoreCache?: boolean } = {}) => {
        this.reloadOptions.push(params);
        this.events.push("reload");
      },
      getFrameTree: async () => ({ frameTree: { frame: this.frame } }),
    };
  }

  public readonly Accessibility = {
    getFullAXTree: async (_params: { frameId: string }) => ({ nodes: this.axNodes }),
  };

  public readonly DOM = {
    focus: async ({ backendNodeId }: { backendNodeId: number }) => { this.focusIds.push(backendNodeId); this.events.push("dom.focus"); },
  };

  public readonly Input = {
    insertText: async (_params: { text: string }) => undefined,
    dispatchKeyEvent: async (_params: Record<string, unknown>) => undefined,
  };

  public enableOptions: unknown[] = [];

  public readonly Network = {
    enable: async (options: Record<string, unknown>) => { this.enableOptions.push(options); this.events.push("network.enable"); },
    requestWillBeSent: (listener: RequestListener) => {
      this.events.push("subscribe.request"); this.requestListeners.add(listener); return () => this.requestListeners.delete(listener);
    },
    responseReceived: (listener: ResponseListener) => {
      this.events.push("subscribe.response"); this.responseListeners.add(listener); return () => this.responseListeners.delete(listener);
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
    return this.requestListeners.size + this.responseListeners.size + this.finishedListeners.size + this.failedListeners.size;
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
  assert.deepEqual(client.events.slice(0, 6), [
    "subscribe.request", "subscribe.response", "subscribe.finished", "subscribe.failed", "network.enable", `navigate:${expected}`,
  ]);
  assert.deepEqual(client.enableOptions, [{}]);
});

test("typed reload delegates only Page.reload with normal cache semantics", async () => {
  const { client, session } = await createSession();
  await session.reload();
  assert.deepEqual(client.reloadOptions, [{ ignoreCache: false }]);
  assert.deepEqual(client.events, ["reload"]);
});

test("relevant backend request IDs are metadata-only and loadingFinished clears them", async () => {
  const { client, session } = await createSession(); await session.initializeReadinessObservation();
  client.emitRequest("req-1", "https://chatgpt.com/backend-api/models?authorization=QUERY_SECRET#fragment");
  const active = await session.getReadinessSnapshot({ kind: "THREAD", locator: expected });
  assert.equal(active.backendActivity.activeCount, 1);
  assert.equal(JSON.stringify(active).includes("QUERY_SECRET"), false);
  client.emitFinished("req-1");
  const settled = await session.getReadinessSnapshot({ kind: "THREAD", locator: expected });
  assert.equal(settled.backendActivity.activeCount, 0);
  assert.ok(settled.backendActivity.activityEpoch > active.backendActivity.activityEpoch);
});

test("loadingFailed clears relevant activity and ignored traffic never blocks", async () => {
  const { client, session } = await createSession(); await session.initializeReadinessObservation();
  client.emitRequest("ignored", "https://example.com/backend-api/ignored?secret=1");
  assert.equal((await session.getReadinessSnapshot({ kind: "THREAD", locator: expected })).backendActivity.activeCount, 0);
  client.emitRequest("req-2", "https://chatgpt.com/backend-api/conversations");
  assert.equal((await session.getReadinessSnapshot({ kind: "THREAD", locator: expected })).backendActivity.activeCount, 1);
  client.emitFailed("req-2");
  assert.equal((await session.getReadinessSnapshot({ kind: "THREAD", locator: expected })).backendActivity.activeCount, 0);
});

test("main-frame route is normalized internally without exposing current URL or query", async () => {
  const { session } = await createSession(); await session.initializeReadinessObservation();
  const snapshot = await session.getReadinessSnapshot({ kind: "THREAD", locator: expected });
  assert.equal(snapshot.mainFrame.expectedRoute, true);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("locator_canary"), false);
  assert.equal(serialized.includes("synthetic-a"), false);
});

test("FRESH_ROOT route matching semantics", async () => {
  const { client, session } = await createSession();
  await session.initializeReadinessObservation();

  client.frame.url = "https://chatgpt.com/";
  let snapshot = await session.getReadinessSnapshot({ kind: "FRESH_ROOT" });
  assert.equal(snapshot.mainFrame.expectedRoute, true);

  client.frame.url = "https://chatgpt.com/?synthetic=1#fragment";
  snapshot = await session.getReadinessSnapshot({ kind: "FRESH_ROOT" });
  assert.equal(snapshot.mainFrame.expectedRoute, true);
  assert.equal(JSON.stringify(snapshot).includes("synthetic=1"), false);

  client.frame.url = "https://chatgpt.com/c/synthetic";
  snapshot = await session.getReadinessSnapshot({ kind: "FRESH_ROOT" });
  assert.equal(snapshot.mainFrame.expectedRoute, false);

  client.frame.url = "https://chatgpt.com/g/g-some-gpt";
  snapshot = await session.getReadinessSnapshot({ kind: "FRESH_ROOT" });
  assert.equal(snapshot.mainFrame.expectedRoute, false);

  client.frame.url = "https://chatgpt.com/c/synthetic-a";
  snapshot = await session.getReadinessSnapshot({ kind: "THREAD", locator: expected });
  assert.equal(snapshot.mainFrame.expectedRoute, true);
});

test("wrong and transient main-frame routes are simply not ready", async () => {
  const { client, session } = await createSession(); await session.initializeReadinessObservation();
  client.frame = { id: "main", loaderId: "loader-a", url: "https://chatgpt.com/c/synthetic-other?secret=WRONG_ROUTE" };
  let snapshot = await session.getReadinessSnapshot({ kind: "THREAD", locator: expected });
  assert.equal(snapshot.mainFrame.expectedRoute, false);
  assert.equal(JSON.stringify(snapshot).includes("WRONG_ROUTE"), false);
  client.frame = { id: "main", loaderId: "loader-b", url: "about:blank" };
  snapshot = await session.getReadinessSnapshot({ kind: "THREAD", locator: expected });
  assert.equal(snapshot.mainFrame.expectedRoute, false);
});

test("Accessibility mapping retains only eligible state and omits accessible text", async () => {
  const { session } = await createSession(); await session.initializeReadinessObservation();
  const snapshot = await session.getReadinessSnapshot({ kind: "THREAD", locator: expected });
  assert.deepEqual(snapshot.eligibleEditables, [{ backendDOMNodeId: 101, focused: false }]);
  assert.equal(JSON.stringify(snapshot).includes("ACCESSIBLE_TEXT_CANARY"), false);
});

test("Accessibility classification requires exactly the narrow multiline editable shape", async () => {
  const { client, session } = await createSession(); await session.initializeReadinessObservation();
  client.axNodes = [
    { ignored: false, role: { value: "textbox" }, backendDOMNodeId: 1, properties: [] },
    { ignored: false, role: { value: "button" }, backendDOMNodeId: 2, properties: [] },
  ];
  assert.deepEqual((await session.getReadinessSnapshot({ kind: "THREAD", locator: expected })).eligibleEditables, []);
});

test("typed mutation surface exposes focus and reload but not a generic send primitive", async () => {
  const { client, session } = await createSession(); await session.initializeReadinessObservation();
  await session.focusBackendNode(101);
  assert.deepEqual(client.focusIds, [101]);
  assert.equal("send" in session, false);
  assert.equal("reload" in session, true);
});

test("disconnect clears readiness request tracking/listeners and closes the observation lifecycle", async () => {
  const { client, session } = await createSession(); await session.initializeReadinessObservation();
  client.emitRequest("req-3", "https://chatgpt.com/backend-api/models");
  assert.equal((await session.getReadinessSnapshot({ kind: "THREAD", locator: expected })).backendActivity.activeCount, 1);
  assert.equal(client.networkListenerCount(), 4);

  client.emitDisconnect();

  assert.equal(client.networkListenerCount(), 0);
  await assert.rejects(() => session.getReadinessSnapshot({ kind: "THREAD", locator: expected }));
  await assert.rejects(() => session.initializeReadinessObservation());
});

test("timed transport attach closes a valid CRI client that resolves late", async () => {
  let resolveClient!: (client: FakeCriClient) => void;
  const clientPromise = new Promise<FakeCriClient>((resolve) => {
    resolveClient = resolve;
  });
  const transport = new ChromeRemoteInterfaceTransport({
    connect: async () => await clientPromise,
  });
  const connecting = withTimeout(
    (signal) => transport.connect({
      host: "127.0.0.1",
      port: 9223,
      target,
      signal,
    }),
    20,
  );

  await assert.rejects(connecting, OperationTimeoutError);

  const lateClient = new FakeCriClient();
  resolveClient(lateClient);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(lateClient.closeCalls, 1);
});

test("parent-aborted transport attach closes a valid CRI client that resolves late", async () => {
  let resolveClient!: (client: FakeCriClient) => void;
  const clientPromise = new Promise<FakeCriClient>((resolve) => {
    resolveClient = resolve;
  });
  const transport = new ChromeRemoteInterfaceTransport({
    connect: async () => await clientPromise,
  });
  const controller = new AbortController();
  const connecting = transport.connect({
    host: "127.0.0.1",
    port: 9223,
    target,
    signal: controller.signal,
  });

  controller.abort(new Error("synthetic parent cancellation"));
  await assert.rejects(connecting, OperationAbortedError);

  const lateClient = new FakeCriClient();
  resolveClient(lateClient);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(lateClient.closeCalls, 1);
});
