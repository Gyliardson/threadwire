import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ThreadNotFoundError,
  ThreadRegistryPersistenceError,
  ThreadRegistryStateInvalidError,
} from "../../src/domain/errors.js";
import {
  ThreadHandle,
  createConversationLocator,
  createThreadHandle,
} from "../../src/domain/ThreadIdentity.js";
import {
  JsonFileThreadRegistryStore,
  ThreadRegistryRecord,
  ThreadRegistryStore,
} from "../../src/persistence/ThreadRegistryStore.js";
import { ThreadRegistry } from "../../src/routing/ThreadRegistry.js";

function withTempStore<T>(run: (store: JsonFileThreadRegistryStore) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "threadwire-m9-registry-"));
  try {
    return run(new JsonFileThreadRegistryStore(join(directory, "thread-registry.v1.json")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("M9 restores the same opaque handle across ThreadRegistry instances", () => {
  withTempStore((store) => {
    const locator = createConversationLocator("https://chatgpt.com/c/synthetic-persistent-thread");
    const first = new ThreadRegistry({
      handleFactory: () => "persistent-handle",
      store,
    });
    const registration = first.registerWithStatus(locator);

    assert.equal(registration.threadHandle, "tw_persistent-handle");
    assert.equal(registration.created, true);

    const restored = new ThreadRegistry({
      handleFactory: () => "must-not-replace-restored-handle",
      store,
    });
    assert.deepEqual(restored.knownThreads(), [registration.threadHandle]);
    assert.equal(restored.resolve(registration.threadHandle), locator);
    assert.deepEqual(restored.registerWithStatus(locator), {
      threadHandle: registration.threadHandle,
      created: false,
    });
  });
});

test("M9 persists before exposing a newly registered handle in memory", () => {
  class FailingStore implements ThreadRegistryStore {
    public load(): readonly ThreadRegistryRecord[] {
      return [];
    }

    public save(_records: readonly ThreadRegistryRecord[]): void {
      throw new ThreadRegistryPersistenceError();
    }
  }

  const registry = new ThreadRegistry({
    handleFactory: () => "not-committed",
    store: new FailingStore(),
  });
  const locator = createConversationLocator("https://chatgpt.com/c/synthetic-not-committed");

  assert.throws(() => registry.register(locator), ThreadRegistryPersistenceError);
  assert.deepEqual(registry.knownThreads(), []);
  assert.throws(() => registry.resolve("tw_not-committed" as ThreadHandle), ThreadNotFoundError);
});

test("M9 rejects conflicting records even when supplied by a custom store", () => {
  class ConflictingStore implements ThreadRegistryStore {
    public load(): readonly ThreadRegistryRecord[] {
      return [
        {
          threadHandle: createThreadHandle("tw_a"),
          conversationLocator: createConversationLocator("https://chatgpt.com/c/synthetic-a"),
        },
        {
          threadHandle: createThreadHandle("tw_a"),
          conversationLocator: createConversationLocator("https://chatgpt.com/c/synthetic-b"),
        },
      ];
    }

    public save(_records: readonly ThreadRegistryRecord[]): void {}
  }

  assert.throws(
    () => new ThreadRegistry({ store: new ConflictingStore() }),
    ThreadRegistryStateInvalidError,
  );
});
