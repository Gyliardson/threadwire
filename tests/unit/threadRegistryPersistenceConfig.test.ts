import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import test from "node:test";
import { InvalidConfigurationError } from "../../src/domain/errors.js";
import {
  THREAD_REGISTRY_STATE_FILENAME,
  loadThreadRegistryPersistenceConfig,
} from "../../src/persistence/ThreadRegistryPersistenceConfig.js";

test("M9 persistence defaults beneath LOCALAPPDATA", () => {
  const localAppData = resolve("synthetic-local-app-data");
  const config = loadThreadRegistryPersistenceConfig({ LOCALAPPDATA: localAppData });

  assert.equal(config.stateDirectory, join(localAppData, "Threadwire"));
  assert.equal(config.stateFile, join(localAppData, "Threadwire", THREAD_REGISTRY_STATE_FILENAME));
});

test("M9 persistence accepts an explicit absolute state directory", () => {
  const stateDirectory = resolve("synthetic-threadwire-state");
  const config = loadThreadRegistryPersistenceConfig({ THREADWIRE_STATE_DIR: stateDirectory });

  assert.equal(config.stateDirectory, stateDirectory);
  assert.equal(config.stateFile, join(stateDirectory, THREAD_REGISTRY_STATE_FILENAME));
});

test("M9 persistence rejects missing or relative state roots", () => {
  assert.throws(() => loadThreadRegistryPersistenceConfig({}), InvalidConfigurationError);
  assert.throws(
    () => loadThreadRegistryPersistenceConfig({ THREADWIRE_STATE_DIR: "relative-state" }),
    InvalidConfigurationError,
  );
  assert.throws(
    () => loadThreadRegistryPersistenceConfig({ THREADWIRE_STATE_DIR: "bad\0state" }),
    InvalidConfigurationError,
  );
});
