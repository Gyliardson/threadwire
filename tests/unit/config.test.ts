import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../src/config/ControllerConfig.js";
import { InvalidConfigurationError } from "../../src/domain/errors.js";

test("loadConfig returns the loopback managed defaults", () => {
  assert.deepEqual(loadConfig({}), {
    cdpHost: "127.0.0.1",
    cdpPort: 9223,
    classicPolicy: "MANAGED",
  });
});

test("loadConfig accepts the full valid TCP port range", () => {
  assert.equal(loadConfig({ THREADWIRE_CDP_PORT: "1" }).cdpPort, 1);
  assert.equal(loadConfig({ THREADWIRE_CDP_PORT: "65535" }).cdpPort, 65535);
});

test("loadConfig accepts the opt-in bound-existing Classic policy", () => {
  assert.equal(
    loadConfig({ THREADWIRE_CLASSIC_POLICY: "BOUND_EXISTING" }).classicPolicy,
    "BOUND_EXISTING",
  );
});

test("loadConfig rejects invalid Classic policy values", () => {
  for (const policy of ["", "managed", "BOUND", "BOUND_EXISTING "]) {
    assert.throws(
      () => loadConfig({ THREADWIRE_CLASSIC_POLICY: policy }),
      InvalidConfigurationError,
    );
  }
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
