import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../src/config/ControllerConfig.js";
import { InvalidConfigurationError } from "../../src/domain/errors.js";

test("loadConfig returns the loopback defaults", () => {
  assert.deepEqual(loadConfig({}), { cdpHost: "127.0.0.1", cdpPort: 9223 });
});

test("loadConfig accepts the full valid TCP port range", () => {
  assert.equal(loadConfig({ THREADWIRE_CDP_PORT: "1" }).cdpPort, 1);
  assert.equal(loadConfig({ THREADWIRE_CDP_PORT: "65535" }).cdpPort, 65535);
});

test("loadConfig rejects non-loopback and empty hosts", () => {
  for (const host of ["0.0.0.0", "localhost", "::1", ""]) {
    assert.throws(() => loadConfig({ THREADWIRE_CDP_HOST: host }), InvalidConfigurationError);
  }
});

test("loadConfig parses the port strictly instead of using parseInt prefixes", () => {
  for (const port of ["0", "65536", "9223abc", " 9223", "+9223", "09", "", "1.5"]) {
    assert.throws(() => loadConfig({ THREADWIRE_CDP_PORT: port }), InvalidConfigurationError);
  }
});
