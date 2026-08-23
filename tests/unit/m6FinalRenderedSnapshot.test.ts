import assert from "node:assert/strict";
import test from "node:test";
import { ChromeRemoteInterfaceSession } from "../../src/cdp/ChromeRemoteInterfaceSession.js";
import { ChromeRemoteInterfaceTransport } from "../../src/cdp/ChromeRemoteInterfaceTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { createConversationLocator } from "../../src/domain/ThreadIdentity.js";

const target: CdpTargetInfo = {
  id: "final-snapshot-target",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/final-snapshot-target",
  url: "https://chatgpt.com/c/final-snapshot",
};

class FakeFinalSnapshotCriClient {
  public frameUrl = target.url;
  public readonly evaluateCalls: string[] = [];
  public readonly evaluateResults: unknown[] = [];
  private readonly disconnectListeners = new Set<() => void>();
  private readonly requestListeners = new Set<(event: never) => void>();
  private readonly responseListeners = new Set<(event: never) => void>();
  private readonly finishedListeners = new Set<(event: never) => void>();
  private readonly failedListeners = new Set<(event: never) => void>();

  public readonly Page = {
    navigate: async (_params: { url: string }) => ({}),
    reload: async (_params: { ignoreCache?: boolean } = {}) => undefined,
    getFrameTree: async () => ({
      frameTree: {
        frame: { id: "main", loaderId: "loader", url: this.frameUrl },
      },
    }),
  };
  public readonly Accessibility = {
    getFullAXTree: async (_params: { frameId: string }) => ({ nodes: [] }),
  };
  public readonly DOM = { focus: async (_params: { backendNodeId: number }) => undefined };
  public readonly Input = {
    insertText: async (_params: { text: string }) => undefined,
    dispatchKeyEvent: async (_params: Record<string, unknown>) => undefined,
  };
  public readonly Network = {
    enable: async (_options: Record<string, unknown>) => undefined,
    requestWillBeSent: (listener: (event: never) => void) => {
      this.requestListeners.add(listener);
      return () => this.requestListeners.delete(listener);
    },
    responseReceived: (listener: (event: never) => void) => {
      this.responseListeners.add(listener);
      return () => this.responseListeners.delete(listener);
    },
    loadingFinished: (listener: (event: never) => void) => {
      this.finishedListeners.add(listener);
      return () => this.finishedListeners.delete(listener);
    },
    loadingFailed: (listener: (event: never) => void) => {
      this.failedListeners.add(listener);
      return () => this.failedListeners.delete(listener);
    },
  };
  public readonly Runtime = {
    evaluate: async ({ expression }: { expression: string; returnByValue?: boolean }) => {
      this.evaluateCalls.push(expression);
      if (this.evaluateResults.length === 0) {
        throw new Error("No synthetic Runtime.evaluate result configured.");
      }
      return this.evaluateResults.shift();
    },
  };

  public async close(): Promise<void> {}

  public on(event: "disconnect", listener: () => void): void {
    if (event === "disconnect") {
      this.disconnectListeners.add(listener);
    }
  }
}

async function createSession(client: FakeFinalSnapshotCriClient): Promise<ChromeRemoteInterfaceSession> {
  const transport = new ChromeRemoteInterfaceTransport({ connect: async () => client });
  const session = (await transport.connect({
    host: "127.0.0.1",
    port: 9223,
    target,
  })) as ChromeRemoteInterfaceSession;
  await session.initializeReadinessObservation();
  return session;
}

function evaluateValue(value: unknown): unknown {
  return { result: { value } };
}

test("render baseline returns only bounded structural message counts", async () => {
  const client = new FakeFinalSnapshotCriClient();
  client.evaluateResults.push(evaluateValue({ userCount: 3, assistantCount: 2 }));
  const session = await createSession(client);

  assert.deepEqual(await session.captureTurnResponseRenderBaseline(), {
    userCount: 3,
    assistantCount: 2,
  });
  assert.equal(client.evaluateCalls.length, 1);
  assert.equal(client.evaluateCalls[0]!.includes("data-message-author-role"), true);
  assert.equal(client.evaluateCalls[0]!.includes("innerText"), false);
});

test("final rendered snapshot returns an authoritative bounded assistant innerText only on the expected route", async () => {
  const client = new FakeFinalSnapshotCriClient();
  const finalText = "FINAL_RENDERED_TEXT_CANARY";
  client.evaluateResults.push(evaluateValue({ state: "READY", text: finalText }));
  const session = await createSession(client);
  const locator = createConversationLocator(target.url);

  assert.deepEqual(
    await session.getFinalRenderedAssistantSnapshot(
      { userCount: 3, assistantCount: 2 },
      { kind: "THREAD", locator },
    ),
    { text: finalText },
  );
  assert.equal(client.evaluateCalls.length, 1);
  assert.equal(client.evaluateCalls[0]!.includes("innerText"), true);
  assert.equal(client.evaluateCalls[0]!.includes("textContent"), false);
  assert.equal(client.evaluateCalls[0]!.includes("HTMLElement"), true);
  assert.equal(client.evaluateCalls[0]!.includes("1048576"), true);
});

test("final rendered snapshot refuses route drift before reading assistant DOM text", async () => {
  const client = new FakeFinalSnapshotCriClient();
  const session = await createSession(client);
  const locator = createConversationLocator(target.url);
  client.frameUrl = "https://chatgpt.com/";

  assert.equal(
    await session.getFinalRenderedAssistantSnapshot(
      { userCount: 3, assistantCount: 2 },
      { kind: "THREAD", locator },
    ),
    null,
  );
  assert.equal(client.evaluateCalls.length, 0);
});

test("NOT_READY final rendered structure remains non-terminal and returns no text", async () => {
  const client = new FakeFinalSnapshotCriClient();
  client.evaluateResults.push(evaluateValue({ state: "NOT_READY" }));
  const session = await createSession(client);
  const locator = createConversationLocator(target.url);

  assert.equal(
    await session.getFinalRenderedAssistantSnapshot(
      { userCount: 3, assistantCount: 2 },
      { kind: "THREAD", locator },
    ),
    null,
  );
});

test("oversized and malformed rendered snapshot states fail with sanitized errors", async () => {
  const locator = createConversationLocator(target.url);

  const tooLarge = new FakeFinalSnapshotCriClient();
  tooLarge.evaluateResults.push(evaluateValue({ state: "TOO_LARGE" }));
  const tooLargeSession = await createSession(tooLarge);
  await assert.rejects(
    () =>
      tooLargeSession.getFinalRenderedAssistantSnapshot(
        { userCount: 0, assistantCount: 0 },
        { kind: "THREAD", locator },
      ),
    /exceeded its bounded capacity/,
  );

  const malformed = new FakeFinalSnapshotCriClient();
  const rawCanary = "RAW_RENDERED_DOM_CANARY";
  malformed.evaluateResults.push(evaluateValue({ state: "READY", wrong: rawCanary }));
  const malformedSession = await createSession(malformed);
  let captured: unknown;
  try {
    await malformedSession.getFinalRenderedAssistantSnapshot(
      { userCount: 0, assistantCount: 0 },
      { kind: "THREAD", locator },
    );
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof Error);
  assert.equal(captured.message.includes(rawCanary), false);
  assert.equal(JSON.stringify(captured).includes(rawCanary), false);
});

test("Runtime.evaluate exception details are never retained in outward snapshot errors", async () => {
  const client = new FakeFinalSnapshotCriClient();
  const rawCanary = "RAW_RUNTIME_EXCEPTION_CANARY";
  client.evaluateResults.push({
    result: { value: undefined },
    exceptionDetails: { text: rawCanary },
  });
  const session = await createSession(client);

  let captured: unknown;
  try {
    await session.captureTurnResponseRenderBaseline();
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof Error);
  assert.equal(captured.message.includes(rawCanary), false);
  assert.equal(JSON.stringify(captured).includes(rawCanary), false);
});
