import test from "node:test";
import assert from "node:assert";
import { loadConfig } from "../../src/config/ControllerConfig.js";

test("loadConfig returns default configuration when env is empty", () => {
  const config = loadConfig({});
  assert.strictEqual(config.cdpHost, "127.0.0.1");
  assert.strictEqual(config.cdpPort, 9223);
});

test("loadConfig parses valid THREADWIRE_CDP_PORT", () => {
  const config = loadConfig({ THREADWIRE_CDP_PORT: "9224" });
  assert.strictEqual(config.cdpPort, 9224);
});

test("loadConfig throws error on invalid host", () => {
  assert.throws(() => loadConfig({ THREADWIRE_CDP_HOST: "0.0.0.0" }), {
    message: /Security Violation/
  });
});

test("loadConfig throws error on invalid port", () => {
  assert.throws(() => loadConfig({ THREADWIRE_CDP_PORT: "abc" }), {
    message: /Invalid THREADWIRE_CDP_PORT/
  });
  assert.throws(() => loadConfig({ THREADWIRE_CDP_PORT: "70000" }), {
    message: /Invalid THREADWIRE_CDP_PORT/
  });
});
