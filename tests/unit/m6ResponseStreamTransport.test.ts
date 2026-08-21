import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { ChromeRemoteInterfaceTransport } from "../../src/cdp/ChromeRemoteInterfaceTransport.js";
import { CdpResponseTurnTransportSession } from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

function b64(value: string): string {
  return Buffer.from(value).toString("base64");
}

function delta(text: string): string {
  return `event: delta\ndata: ${JSON.stringify({ v: text })}\n\n`;
}

const target: CdpTargetInfo = {
  id: "m6-target",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/m6-target",
  url: "https://chatgpt.com/c/m6-synthetic",
};

type RequestListener = (event: {
  requestId: string;
  request: { url: string; method?: string };
  redirectResponse?: { status: number };
}) => void;
type ResponseListener = (event: { requestId: string; response: { status: number } }) => void;
type SettledListener = (event: { requestId: string }) => void;
type DataListener = (event: { requestId: string; data?: string }) => void;

class FakeM6CriClient {
  public readonly streamCalls: string[] = [];
  public streamResult: Promise<{ bufferedData?: string }> = Promise.resolve({ bufferedData: "" });
  public readonly frame = { id: "main", loaderId: "loader", url: target.url };
  private readonly disconnectListeners = new Set<() => void>();
  private readonly requestListeners = new Set<RequestListener>();
  private readonly responseListeners = new Set<ResponseListener>();
  private readonly finishedListeners = new Set<SettledListener>();
  private readonly failedListeners = new Set<SettledListener>();
  private readonly dataListeners = new Set<DataListener>();

  public readonly Page = {
    navigate: async (_params: { url: string }) => ({}),
    getFrameTree: async () => ({ frameTree: { frame: this.frame } }),
  };
  public readonly Accessibility = {
    getFullAXTree: async (_params: { frameId: string }) => ({ nodes: [] }),
  };
  public readonly DOM = { focus: async (_params: { backendNodeId: number }) => undefined };
  public readonly Input = {
    insertText: async (_params: { text: string }) => undefined,
    dispatchKeyEvent: async (_params: Record<string, unknown>) => undefined,
  };
  public readonly Network: Record<string, unknown> & {
    enable: (_options: Record<string, unknown>) => Promise<void>;
    requestWillBeSent: (listener: RequestListener) => () => boolean;
    responseReceived: (listener: ResponseListener) => () => boolean;
    loadingFinished: (listener: SettledListener) => () => boolean;
    loadingFailed: (listener: SettledListener) => () => boolean;
    dataReceived?: (listener: DataListener) => () => boolean;
    streamResourceContent?: (params: { requestId: string }) => Promise<{ bufferedData?: string }>;
  };

  public constructor(capabilities: { data?: boolean; stream?: boolean } = { data: true, stream: true }) {
    this.Network = {
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
    if (capabilities.data !== false) {
      this.Network.dataReceived = (listener: DataListener) => {
        this.dataListeners.add(listener);
        return () => this.dataListeners.delete(listener);
      };
    }
    if (capabilities.stream !== false) {
      this.Network.streamResourceContent = async ({ requestId }: { requestId: string }) => {
        this.streamCalls.push(requestId);
        return await this.streamResult;
      };
    }
  }

  public async close(): Promise<void> {}
  public on(event: "disconnect", listener: () => void): void {
    if (event === "disconnect") this.disconnectListeners.add(listener);
  }
  public emitDisconnect(): void {
    for (const listener of this.disconnectListeners) listener();
  }
  public emitRequest(requestId: string, redirected = false, url = "https://chatgpt.com/backend-api/f/conversation", method = "POST"): void {
    for (const listener of this.requestListeners) {
      listener({
        requestId,
        request: { url, method },
        ...(redirected ? { redirectResponse: { status: 302 } } : {}),
      });
    }
  }
  public emitResponse(requestId: string, status: number): void {
    for (const listener of this.responseListeners) listener({ requestId, response: { status } });
  }
  public emitData(requestId: string, data: string): void {
    for (const listener of this.dataListeners) listener({ requestId, data });
  }
  public emitFinished(requestId: string): void {
    for (const listener of this.finishedListeners) listener({ requestId });
  }
  public emitFailed(requestId: string): void {
    for (const listener of this.failedListeners) listener({ requestId });
  }
}

async function createSession(client: FakeM6CriClient): Promise<CdpResponseTurnTransportSession> {
  const transport = new ChromeRemoteInterfaceTransport({ connect: async () => client });
  const session = (await transport.connect({ host: "127.0.0.1", port: 9223, target })) as CdpResponseTurnTransportSession;
  await session.initializeReadinessObservation();
  return session;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("M0-M5 attach and ordinary turn observation do not require response-stream capability", async () => {
  const client = new FakeM6CriClient({ data: false, stream: false });
  const session = await createSession(client);
  const handle = session.armTurnObservation();
  client.emitRequest("private-write-id");
  client.emitResponse("private-write-id", 200);
  client.emitFinished("private-write-id");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "FINISHED");
  assert.equal("response" in session.getTurnObservation(handle), false);
});

test("streamResourceContent activates only for the exact selected direct successful write", async () => {
  const client = new FakeM6CriClient();
  const session = await createSession(client);
  const handle = session.armTurnObservation({ responseStream: true });
  client.emitRequest("selected-private-id");
  client.emitResponse("wrong-private-id", 200);
  assert.deepEqual(client.streamCalls, []);
  client.emitResponse("selected-private-id", 200);
  await flush();
  assert.deepEqual(client.streamCalls, ["selected-private-id"]);
  assert.equal(JSON.stringify(session.getTurnObservation(handle)).includes("selected-private-id"), false);
});

test("bufferedData is consumed before live data queued while activation is pending", async () => {
  const client = new FakeM6CriClient();
  const activation = deferred<{ bufferedData?: string }>();
  client.streamResult = activation.promise;
  const session = await createSession(client);
  const handle = session.armTurnObservation({ responseStream: true });
  client.emitRequest("selected");
  client.emitResponse("selected", 200);
  client.emitData("selected", b64(delta("live")));
  activation.resolve({ bufferedData: b64(delta("buffered")) });
  await flush();
  assert.deepEqual(session.takeTurnResponseEvents(handle), [
    { type: "TEXT_DELTA", text: "buffered" },
    { type: "TEXT_DELTA", text: "live" },
  ]);
});

test("wrong RequestId dataReceived is ignored", async () => {
  const client = new FakeM6CriClient();
  const session = await createSession(client);
  const handle = session.armTurnObservation({ responseStream: true });
  client.emitRequest("selected");
  client.emitResponse("selected", 200);
  await flush();
  client.emitData("wrong", b64(delta("wrong")));
  client.emitData("selected", b64(delta("right")));
  assert.deepEqual(session.takeTurnResponseEvents(handle), [{ type: "TEXT_DELTA", text: "right" }]);
});

test("redirected selected leg never activates from a later-hop 2xx and remains M5 failure", async () => {
  const client = new FakeM6CriClient();
  const session = await createSession(client);
  const handle = session.armTurnObservation({ responseStream: true });
  client.emitRequest("selected");
  client.emitResponse("selected", 302);
  client.emitRequest("selected", true, "https://chatgpt.com/redirect-target", "GET");
  client.emitResponse("selected", 200);
  client.emitData("selected", b64(delta("must-not-emit") + "data: [DONE]\n\n"));
  await flush();
  assert.deepEqual(client.streamCalls, []);
  assert.deepEqual(session.takeTurnResponseEvents(handle), []);
  client.emitFinished("selected");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "FAILED");
  assert.notEqual(session.getTurnObservation(handle).response?.lifecycle, "COMPLETED");
});

test("second distinct matching write remains fail-closed and disposes response state", async () => {
  const client = new FakeM6CriClient();
  const session = await createSession(client);
  const handle = session.armTurnObservation({ responseStream: true });
  client.emitRequest("first");
  client.emitRequest("second");
  assert.throws(() => session.getTurnObservation(handle), /ambiguous or unsafe/);
});

test("[DONE] before loadingFinished marks semantic completion while M5 transport stays ACTIVE", async () => {
  const client = new FakeM6CriClient();
  const session = await createSession(client);
  const handle = session.armTurnObservation({ responseStream: true });
  client.emitRequest("selected");
  client.emitResponse("selected", 200);
  await flush();
  client.emitData("selected", b64(delta("answer") + "data: [DONE]\n\n"));
  assert.deepEqual(session.takeTurnResponseEvents(handle), [
    { type: "TEXT_DELTA", text: "answer" },
    { type: "COMPLETED" },
  ]);
  assert.equal(session.getTurnObservation(handle).response?.lifecycle, "COMPLETED");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "ACTIVE");
  client.emitFinished("selected");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "FINISHED");
  assert.equal(session.getTurnObservation(handle).response?.lifecycle, "COMPLETED");
});

test("loadingFailed before [DONE] never fabricates semantic completion", async () => {
  const client = new FakeM6CriClient();
  const session = await createSession(client);
  const handle = session.armTurnObservation({ responseStream: true });
  client.emitRequest("selected");
  client.emitResponse("selected", 200);
  await flush();
  client.emitData("selected", b64(delta("partial")));
  client.emitFailed("selected");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "FAILED");
  assert.equal(session.getTurnObservation(handle).response?.lifecycle, "FAILED");
  assert.notEqual(session.getTurnObservation(handle).response?.failure, null);
  assert.equal(session.takeTurnResponseEvents(handle).some((event) => event.type === "COMPLETED"), false);
});

test("loadingFinished without [DONE] becomes INCOMPLETE and does not fabricate completion", async () => {
  const client = new FakeM6CriClient();
  const session = await createSession(client);
  const handle = session.armTurnObservation({ responseStream: true });
  client.emitRequest("selected");
  client.emitResponse("selected", 200);
  await flush();
  client.emitData("selected", b64(delta("partial")));
  client.emitFinished("selected");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "FINISHED");
  assert.deepEqual(session.getTurnObservation(handle).response, {
    lifecycle: "FAILED",
    failure: "INCOMPLETE",
  });
  assert.deepEqual(session.takeTurnResponseEvents(handle), [{ type: "TEXT_DELTA", text: "partial" }]);
});

test("loadingFinished while stream activation is pending waits for bufferedData deterministically", async () => {
  const client = new FakeM6CriClient();
  const activation = deferred<{ bufferedData?: string }>();
  client.streamResult = activation.promise;
  const session = await createSession(client);
  const handle = session.armTurnObservation({ responseStream: true });
  client.emitRequest("selected");
  client.emitResponse("selected", 200);
  client.emitFinished("selected");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "FINISHED");
  assert.equal(session.getTurnObservation(handle).response?.lifecycle, "PENDING");
  activation.resolve({ bufferedData: b64(delta("buffered") + "data: [DONE]\n\n") });
  await flush();
  assert.deepEqual(session.takeTurnResponseEvents(handle), [
    { type: "TEXT_DELTA", text: "buffered" },
    { type: "COMPLETED" },
  ]);
  assert.equal(session.getTurnObservation(handle).response?.lifecycle, "COMPLETED");
});

test("missing experimental capability is stable M6 failure and does not break M5 settlement", async () => {
  for (const capabilities of [
    { data: false, stream: true },
    { data: true, stream: false },
  ]) {
    const client = new FakeM6CriClient(capabilities);
    const session = await createSession(client);
    const handle = session.armTurnObservation({ responseStream: true });
    client.emitRequest("PRIVATE_REQUEST_ID_CANARY");
    client.emitResponse("PRIVATE_REQUEST_ID_CANARY", 200);
    await flush();
    assert.deepEqual(session.getTurnObservation(handle).response, {
      lifecycle: "FAILED",
      failure: "UNAVAILABLE",
    });
    client.emitFinished("PRIVATE_REQUEST_ID_CANARY");
    assert.equal(session.getTurnObservation(handle).write?.lifecycle, "FINISHED");
    assert.equal(JSON.stringify(session.getTurnObservation(handle)).includes("PRIVATE_REQUEST_ID_CANARY"), false);
  }
});

test("stream activation rejection is sanitized and separate from successful M5 settlement", async () => {
  const client = new FakeM6CriClient();
  const activation = deferred<{ bufferedData?: string }>();
  client.streamResult = activation.promise;
  const session = await createSession(client);
  const handle = session.armTurnObservation({ responseStream: true });
  client.emitRequest("PRIVATE_REQUEST_ID_CANARY");
  client.emitResponse("PRIVATE_REQUEST_ID_CANARY", 200);
  activation.reject(new Error("RAW_UPSTREAM_PROTOCOL_CANARY"));
  await flush();
  assert.deepEqual(session.getTurnObservation(handle).response, {
    lifecycle: "FAILED",
    failure: "ACTIVATION_FAILED",
  });
  const serialized = JSON.stringify(session.getTurnObservation(handle));
  assert.equal(serialized.includes("RAW_UPSTREAM_PROTOCOL_CANARY"), false);
  assert.equal(serialized.includes("PRIVATE_REQUEST_ID_CANARY"), false);
  client.emitFinished("PRIVATE_REQUEST_ID_CANARY");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "FINISHED");
});

test("release and disconnect dispose stale response work", async () => {
  const activation = deferred<{ bufferedData?: string }>();
  const client = new FakeM6CriClient();
  client.streamResult = activation.promise;
  const session = await createSession(client);
  const first = session.armTurnObservation({ responseStream: true });
  client.emitRequest("first");
  client.emitResponse("first", 200);
  session.releaseTurnObservation(first);
  activation.resolve({ bufferedData: b64(delta("stale") + "data: [DONE]\n\n") });
  await flush();
  assert.throws(() => session.takeTurnResponseEvents(first));

  const second = session.armTurnObservation({ responseStream: true });
  client.emitDisconnect();
  assert.throws(() => session.getTurnObservation(second));
});

test("RequestId is confined to the CRI adapter source, not public/turn/response seams", async () => {
  const paths = [
    "src/cdp/CdpTransport.ts",
    "src/cdp/CdpSessionManager.ts",
    "src/turn/TurnExecutor.ts",
    "src/turn/types.ts",
    "src/response/ResponseStreamConsumer.ts",
    "src/response/types.ts",
    "src/domain/errors.ts",
  ];
  for (const path of paths) {
    const source = await readFile(resolve(process.cwd(), path), "utf8");
    assert.equal(source.includes("requestId"), false, `${path} must not expose Network.RequestId`);
    assert.equal(source.includes("RequestId"), false, `${path} must not expose Network.RequestId`);
  }
});
