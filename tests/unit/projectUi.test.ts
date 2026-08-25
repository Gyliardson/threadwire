import assert from "node:assert/strict";
import test from "node:test";
import { ChromeRemoteInterfaceSession } from "../../src/cdp/ChromeRemoteInterfaceSession.js";
import { ChromeRemoteInterfaceTransport } from "../../src/cdp/ChromeRemoteInterfaceTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { createProjectName } from "../../src/domain/ProjectIdentity.js";
import { OperationAbortedError } from "../../src/domain/errors.js";

const target: CdpTargetInfo = {
  id: "project-ui-target",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/project-ui-target",
  url: "https://chatgpt.com/",
};

class FakeProjectCriClient {
  public frameUrl = "https://chatgpt.com/g/g-p-synthetic/project";
  public readonly frameUrls: string[] = [];
  public readonly evaluateCalls: string[] = [];
  public readonly evaluateResults: unknown[] = [];
  public readonly insertedText: string[] = [];
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
        frame: {
          id: "main",
          loaderId: "loader",
          url: this.frameUrls.shift() ?? this.frameUrl,
        },
      },
    }),
  };
  public readonly Accessibility = {
    getFullAXTree: async (_params: { frameId: string }) => ({ nodes: [] }),
  };
  public readonly DOM = { focus: async (_params: { backendNodeId: number }) => undefined };
  public readonly Input = {
    insertText: async ({ text }: { text: string }) => { this.insertedText.push(text); },
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
      if (this.evaluateResults.length === 0) throw new Error("No synthetic project result configured.");
      return this.evaluateResults.shift();
    },
  };
  public async close(): Promise<void> {}
  public on(event: "disconnect", listener: () => void): void {
    if (event === "disconnect") this.disconnectListeners.add(listener);
  }
}

function evaluated(value: boolean): unknown {
  return { result: { value } };
}

async function session(client: FakeProjectCriClient): Promise<ChromeRemoteInterfaceSession> {
  const transport = new ChromeRemoteInterfaceTransport({ connect: async () => client });
  const connected = (await transport.connect({ host: "127.0.0.1", port: 9223, target })) as ChromeRemoteInterfaceSession;
  await connected.initializeReadinessObservation();
  return connected;
}

test("project UI uses bounded semantic frontend steps and returns only a validated locator", async () => {
  const client = new FakeProjectCriClient();
  client.frameUrls.push(
    "https://chatgpt.com/g/g-p-existing/project",
    "https://chatgpt.com/g/g-p-existing/project",
    "https://chatgpt.com/g/g-p-synthetic/project",
  );
  client.evaluateResults.push(evaluated(true), evaluated(true), evaluated(true), evaluated(true));
  const connected = await session(client);
  const name = createProjectName("Threadwire Acceptance");
  const locator = await connected.createProjectThroughUi(name);
  assert.equal(locator, "https://chatgpt.com/g/g-p-synthetic/project");
  assert.deepEqual(client.insertedText, [name]);
  assert.equal(client.evaluateCalls.length, 4);
  const source = client.evaluateCalls.join("\n");
  assert.equal(source.includes("fetch("), false);
  assert.equal(source.includes("XMLHttpRequest"), false);
  assert.equal(source.includes("/backend-api/"), false);
  assert.equal(source.includes("data-testid=\"send-button\""), false);
  assert.equal(source.includes("document.body.innerText"), false);
  assert.equal(source.includes("document.title"), false);
  assert.equal(source.includes("querySelectorAll('h1, h2')"), true);
});

test("ambiguous project creation control fails without retaining DOM detail", async () => {
  const client = new FakeProjectCriClient();
  client.evaluateResults.push(evaluated(false));
  const connected = await session(client);
  let captured: unknown;
  try {
    await connected.createProjectThroughUi(createProjectName("Threadwire Acceptance"));
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof Error);
  assert.equal(captured.message.includes("Threadwire Acceptance"), false);
  assert.equal(JSON.stringify(captured).includes("Threadwire Acceptance"), false);
});

test("pre-aborted project UI operation performs no frontend mutation", async () => {
  const client = new FakeProjectCriClient();
  const connected = await session(client);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    connected.createProjectThroughUi(createProjectName("Threadwire Acceptance"), controller.signal),
    OperationAbortedError,
  );
  assert.equal(client.evaluateCalls.length, 0);
  assert.equal(client.insertedText.length, 0);
});
