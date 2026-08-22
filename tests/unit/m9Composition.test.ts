import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("M9 main composes the production controller with the local registry store", async () => {
  const mainSource = await readFile(new URL("../../src/main.ts", import.meta.url), "utf8");

  assert.match(mainSource, /loadThreadRegistryPersistenceConfig\(\)/);
  assert.match(mainSource, /new JsonFileThreadRegistryStore\(persistenceConfig\.stateFile\)/);
  assert.match(
    mainSource,
    /createThreadwireController\(controllerConfig, \{ threadRegistryStore \}\)/,
  );
});

test("M9 keeps the persistent store behind ThreadRegistry", async () => {
  const source = await readFile(
    new URL("../../src/controller/ThreadwireController.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /new ThreadRegistry\(/);
  assert.match(source, /store: options\.threadRegistryStore/);
  assert.doesNotMatch(source, /ConversationLocator/);
});
