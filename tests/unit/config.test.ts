import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import test from "node:test";
import {
  defaultThreadwireStatePath,
  loadConfig,
} from "../../src/config/ControllerConfig.js";
import { InvalidConfigurationError } from "../../src/domain/errors.js";

test("loadConfig returns loopback defaults with state outside the working tree", () => {
  const config = loadConfig({});
  assert.equal(config.cdpHost, "127.0.0.1");
  assert.equal(config.cdpPort, 9223);
  assert.equal(config.statePath, defaultThreadwireStatePath());
  assert.equal(isAbsolute(config.statePath ?? ""), true);
});

test("loadConfig accepts the full valid TCP port range", () => {
  assert.equal(loadConfig({ THREADWIRE_CDP_PORT: "1" }).cdpPort, 1);
  assert.equal(loadConfig({ THREADWIRE_CDP_PORT: "65535" }).cdpPort, 65535);
});

test("loadConfig accepts an absolute state path override", () => {
  const statePath = defaultThreadwireStatePath();
  assert.equal(loadConfig({ THREADWIRE_STATE_PATH: statePath }).statePath, statePath);
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

test("loadConfig rejects empty, relative, and NUL-containing state paths", () => {
  for (const statePath of ["", "state.sqlite3", ".\\state.sqlite3", "C:\\bad\0state.sqlite3"]) {
    assert.throws(
      () => loadConfig({ THREADWIRE_STATE_PATH: statePath }),
      InvalidConfigurationError,
    );
  }
});
