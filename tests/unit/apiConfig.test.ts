import assert from "node:assert/strict";
import test from "node:test";
import { assertApiConfigCompatible, loadApiConfig } from "../../src/api/ApiConfig.js";
import { InvalidConfigurationError } from "../../src/domain/errors.js";

test("loadApiConfig returns an IPv4 loopback default distinct from CDP", () => {
  assert.deepEqual(loadApiConfig({}), { apiHost: "127.0.0.1", apiPort: 9224 });
});

test("loadApiConfig accepts the valid TCP port range", () => {
  assert.equal(loadApiConfig({ THREADWIRE_API_PORT: "1" }).apiPort, 1);
  assert.equal(loadApiConfig({ THREADWIRE_API_PORT: "65535" }).apiPort, 65535);
});

test("loadApiConfig rejects every non-exact loopback host", () => {
  for (const host of ["0.0.0.0", "localhost", "::1", "", "127.0.0.2"]) {
    assert.throws(() => loadApiConfig({ THREADWIRE_API_HOST: host }), InvalidConfigurationError);
  }
});

test("loadApiConfig parses the API port strictly", () => {
  for (const port of ["0", "65536", "9224abc", " 9224", "+9224", "09", "", "1.5"]) {
    assert.throws(() => loadApiConfig({ THREADWIRE_API_PORT: port }), InvalidConfigurationError);
  }
});

test("API and CDP ports may not collide", () => {
  assert.throws(
    () => assertApiConfigCompatible({ apiHost: "127.0.0.1", apiPort: 9223 }, { cdpHost: "127.0.0.1", cdpPort: 9223 }),
    InvalidConfigurationError,
  );
  assert.doesNotThrow(() =>
    assertApiConfigCompatible(
      { apiHost: "127.0.0.1", apiPort: 9224 },
      { cdpHost: "127.0.0.1", cdpPort: 9223 },
    ),
  );
});
