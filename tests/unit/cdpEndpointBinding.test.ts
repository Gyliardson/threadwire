import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeProvenanceUnverifiedError } from "../../src/domain/errors.js";
import { assertTargetDebuggerEndpoint } from "../../src/cdp/CdpEndpointBinding.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";

const config = { cdpHost: "127.0.0.1" as const, cdpPort: 9223 };
function target(webSocketDebuggerUrl: string | null): CdpTargetInfo {
  return { id: "synthetic-target", title: "ChatGPT", type: "page", description: "", url: "https://chatgpt.com/", webSocketDebuggerUrl };
}

test("debugger endpoint binding accepts only the configured localhost CDP endpoint", () => {
  assert.doesNotThrow(() => assertTargetDebuggerEndpoint(target("ws://127.0.0.1:9223/devtools/page/synthetic"), config));
});

test("debugger endpoint binding rejects foreign host", () => {
  assert.throws(() => assertTargetDebuggerEndpoint(target("ws://example.test:9223/devtools/page/synthetic"), config), RuntimeProvenanceUnverifiedError);
});

test("debugger endpoint binding rejects foreign port", () => {
  assert.throws(() => assertTargetDebuggerEndpoint(target("ws://127.0.0.1:9333/devtools/page/synthetic"), config), RuntimeProvenanceUnverifiedError);
});

test("debugger endpoint binding rejects malformed or missing websocket URL", () => {
  for (const value of [null, "not a URL", "http://127.0.0.1:9223/devtools/page/synthetic"]) {
    assert.throws(() => assertTargetDebuggerEndpoint(target(value), config), RuntimeProvenanceUnverifiedError);
  }
});
