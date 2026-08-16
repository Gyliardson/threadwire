import assert from "node:assert/strict";
import test from "node:test";
import {
  CdpEndpointTimeoutError,
  CdpEndpointUnavailableError,
  CdpTargetAmbiguousError,
  CdpTargetListMalformedError,
  CdpTargetNotFoundError,
} from "../../src/domain/errors.js";
import {
  CdpTargetDiscovery,
  CdpTargetListClient,
  parseCdpTargetList,
  selectPrimaryChatGptTarget,
} from "../../src/cdp/CdpTargetDiscovery.js";

const config = { cdpHost: "127.0.0.1" as const, cdpPort: 9223 };

function target(id: string, url: string, type: string = "page") {
  return {
    id,
    title: "ChatGPT",
    type,
    description: "",
    webSocketDebuggerUrl: `ws://127.0.0.1:9223/devtools/page/${id}`,
    url,
  };
}

class StaticClient implements CdpTargetListClient {
  public constructor(private readonly body: string) {}
  public async requestTargetList(): Promise<string> {
    return this.body;
  }
}

class UnavailableClient implements CdpTargetListClient {
  public async requestTargetList(): Promise<string> {
    throw new CdpEndpointUnavailableError();
  }
}

test("target selection uses parsed exact URL semantics and ignores substring lookalikes", () => {
  const selected = selectPrimaryChatGptTarget([
    target("evil-1", "https://evilchatgpt.com/"),
    target("evil-2", "https://chatgpt.com.evil.example/"),
    target("worker", "https://chatgpt.com/backend-api/sentinel/frame.html", "iframe"),
    target("chatgpt", "https://chatgpt.com/c/abc"),
  ]);
  assert.equal(selected.id, "chatgpt");
});

test("target selection rejects no-target and ambiguous eligible-target states", () => {
  assert.throws(
    () => selectPrimaryChatGptTarget([target("other", "https://example.com/")]),
    CdpTargetNotFoundError,
  );
  assert.throws(
    () =>
      selectPrimaryChatGptTarget([
        target("one", "https://chatgpt.com/c/one"),
        target("two", "https://chatgpt.com/c/two"),
      ]),
    CdpTargetAmbiguousError,
  );
});

test("malformed target payloads are rejected explicitly", () => {
  assert.throws(() => parseCdpTargetList("not-json"), CdpTargetListMalformedError);
  assert.throws(
    () => parseCdpTargetList(JSON.stringify([{ id: "missing-fields" }])),
    CdpTargetListMalformedError,
  );
  assert.throws(
    () => selectPrimaryChatGptTarget([target("bad-url", "::not-a-url::")]),
    CdpTargetListMalformedError,
  );
});

test("discovery reports target-not-found when the endpoint is healthy but no ChatGPT page appears", async () => {
  const discovery = new CdpTargetDiscovery(
    config,
    new StaticClient(JSON.stringify([target("other", "https://example.com/")])),
  );
  await assert.rejects(
    () => discovery.findPrimaryTarget({ timeoutMs: 20, pollIntervalMs: 1 }),
    CdpTargetNotFoundError,
  );
});

test("discovery reports endpoint timeout when the localhost endpoint never becomes available", async () => {
  const discovery = new CdpTargetDiscovery(config, new UnavailableClient());
  await assert.rejects(
    () => discovery.findPrimaryTarget({ timeoutMs: 20, pollIntervalMs: 1 }),
    CdpEndpointTimeoutError,
  );
});
