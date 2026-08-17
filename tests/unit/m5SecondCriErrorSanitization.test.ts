import assert from "node:assert/strict";
import test from "node:test";
import { ChromeRemoteInterfaceTransport } from "../../src/cdp/ChromeRemoteInterfaceTransport.js";
import { CdpTurnTransportSession } from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";

type RequestListener = (event: {
  requestId: string;
  request: { url: string; method?: string };
}) => void;
type ResponseListener = (event: { requestId: string; response: { status: number } }) => void;
type SettledListener = (event: { requestId: string }) => void;

class ProtocolErrorCriClient {
  private readonly disconnectListeners = new Set<() => void>();

  public readonly Page = {
    navigate: async (_params: { url: string }) => ({}),
    getFrameTree: async () => ({
      frameTree: {
        frame: {
          id: "main",
          loaderId: "loader",
          url: "https://chatgpt.com/c/m5-error-sanitization",
        },
      },
    }),
  };

  public readonly Accessibility = {
    getFullAXTree: async (_params: { frameId: string }) => ({ nodes: [] }),
  };

  public readonly DOM = {
    focus: async (_params: { backendNodeId: number }) => undefined,
  };

  public readonly Network = {
    enable: async (_options: Record<string, unknown>) => undefined,
    requestWillBeSent: (_listener: RequestListener) => () => undefined,
    responseReceived: (_listener: ResponseListener) => () => undefined,
    loadingFinished: (_listener: SettledListener) => () => undefined,
    loadingFailed: (_listener: SettledListener) => () => undefined,
  };

  public readonly Input = {
    insertText: async (_params: { text: string }) => {
      const raw = new Error("Protocol error (Input.insertText)");
      Object.defineProperty(raw, "request", {
        value: {
          method: "Input.insertText",
          params: { text: "PROMPT_TEXT_SECRET" },
        },
        enumerable: true,
      });
      throw raw;
    },
    dispatchKeyEvent: async (_params: Readonly<Record<string, unknown>>) => undefined,
  };

  public async close(): Promise<void> {}

  public on(event: "disconnect", listener: () => void): void {
    if (event === "disconnect") {
      this.disconnectListeners.add(listener);
    }
  }
}

function graphContains(value: unknown, needle: string, seen = new Set<object>()): boolean {
  if (typeof value === "string") {
    return value.includes(needle);
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return false;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    try {
      if (graphContains((value as Record<PropertyKey, unknown>)[key], needle, seen)) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

const target: CdpTargetInfo = {
  id: "m5-error-sanitization",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/m5-error-sanitization",
  url: "https://chatgpt.com/c/m5-error-sanitization",
};

test("CRI insertText ProtocolError is replaced before leaving the transport adapter", async () => {
  const transport = new ChromeRemoteInterfaceTransport({
    connect: async () => new ProtocolErrorCriClient(),
  });
  const session = (await transport.connect({
    host: "127.0.0.1",
    port: 9223,
    target,
  })) as CdpTurnTransportSession;
  await session.initializeReadinessObservation();

  let captured: unknown;
  try {
    await session.insertText("PROMPT_TEXT_SECRET");
  } catch (error) {
    captured = error;
  }

  assert.ok(captured instanceof Error);
  assert.equal(graphContains(captured, "PROMPT_TEXT_SECRET"), false);
  assert.equal("cause" in captured, false);
});
