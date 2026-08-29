import assert from "node:assert/strict";
import test from "node:test";
import { createConversationLocator, ThreadHandle } from "../../src/domain/ThreadIdentity.js";
import { ThreadNotFoundError } from "../../src/domain/errors.js";
import { ThreadPersistencePort } from "../../src/persistence/ThreadStore.js";
import { ThreadStoreUnavailableError } from "../../src/persistence/errors.js";
import { ThreadRegistry } from "../../src/routing/ThreadRegistry.js";

test("persistence failure cannot create a volatile-only registry mapping", () => {
  const persistence: ThreadPersistencePort = {
    load: () => [],
    insert: () => {
      throw new ThreadStoreUnavailableError();
    },
    close: () => undefined,
  };
  const registry = new ThreadRegistry({
    handleFactory: () => "durability-required",
    persistence,
  });
  const locator = createConversationLocator("https://chatgpt.com/c/synthetic-write-failure");

  assert.throws(() => registry.register(locator), ThreadStoreUnavailableError);
  assert.deepEqual(registry.knownThreads(), []);
  assert.throws(() => registry.resolve("tw_durability-required" as ThreadHandle), ThreadNotFoundError);
});

test("registry close delegates exactly once to persistence", () => {
  let closes = 0;
  const persistence: ThreadPersistencePort = {
    load: () => [],
    insert: () => undefined,
    close: () => {
      closes += 1;
    },
  };
  const registry = new ThreadRegistry({ persistence });

  registry.close();
  assert.equal(closes, 1);
});
