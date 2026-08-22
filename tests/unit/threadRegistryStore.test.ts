import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ThreadRegistryPersistenceError,
  ThreadRegistryStateInvalidError,
} from "../../src/domain/errors.js";
import {
  createConversationLocator,
  createThreadHandle,
} from "../../src/domain/ThreadIdentity.js";
import {
  JsonFileThreadRegistryStore,
  THREAD_REGISTRY_STATE_VERSION,
} from "../../src/persistence/ThreadRegistryStore.js";

function withTempState<T>(run: (directory: string, stateFile: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "threadwire-m9-"));
  try {
    return run(directory, join(directory, "thread-registry.v1.json"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("M9 store treats missing state as an empty registry", () => {
  withTempState((_directory, stateFile) => {
    const store = new JsonFileThreadRegistryStore(stateFile);
    assert.deepEqual(store.load(), []);
  });
});

test("M9 store atomically round-trips strict versioned records", () => {
  withTempState((directory, stateFile) => {
    const store = new JsonFileThreadRegistryStore(stateFile);
    const records = [
      Object.freeze({
        threadHandle: createThreadHandle("tw_persisted-a"),
        conversationLocator: createConversationLocator("https://chatgpt.com/c/synthetic-persisted-a"),
      }),
      Object.freeze({
        threadHandle: createThreadHandle("tw_persisted-b"),
        conversationLocator: createConversationLocator("https://chatgpt.com/c/synthetic-persisted-b"),
      }),
    ];

    store.save(records);
    assert.deepEqual(store.load(), records);
    assert.deepEqual(readdirSync(directory), ["thread-registry.v1.json"]);

    const raw = JSON.parse(readFileSync(stateFile, "utf8")) as {
      version: number;
      threads: unknown[];
    };
    assert.equal(raw.version, THREAD_REGISTRY_STATE_VERSION);
    assert.equal(raw.threads.length, 2);
  });
});

test("M9 store rejects malformed, non-canonical, duplicate, and unknown-version state", () => {
  withTempState((_directory, stateFile) => {
    const store = new JsonFileThreadRegistryStore(stateFile);
    const invalidDocuments: unknown[] = [
      "not-json",
      { version: 99, threads: [] },
      { version: 1, threads: [], extra: true },
      {
        version: 1,
        threads: [
          {
            threadHandle: "invalid",
            conversationLocator: "https://chatgpt.com/c/synthetic-a",
          },
        ],
      },
      {
        version: 1,
        threads: [
          {
            threadHandle: "tw_a",
            conversationLocator: "https://chatgpt.com/c/synthetic-a?query=discarded",
          },
        ],
      },
      {
        version: 1,
        threads: [
          { threadHandle: "tw_a", conversationLocator: "https://chatgpt.com/c/synthetic-a" },
          { threadHandle: "tw_b", conversationLocator: "https://chatgpt.com/c/synthetic-a" },
        ],
      },
      {
        version: 1,
        threads: [
          { threadHandle: "tw_a", conversationLocator: "https://chatgpt.com/c/synthetic-a" },
          { threadHandle: "tw_a", conversationLocator: "https://chatgpt.com/c/synthetic-b" },
        ],
      },
    ];

    for (const document of invalidDocuments) {
      writeFileSync(
        stateFile,
        typeof document === "string" ? document : JSON.stringify(document),
        "utf8",
      );
      assert.throws(() => store.load(), ThreadRegistryStateInvalidError);
    }
  });
});

test("M9 store enforces engineering size bounds", () => {
  withTempState((_directory, stateFile) => {
    writeFileSync(stateFile, "x".repeat(65), "utf8");
    const bounded = new JsonFileThreadRegistryStore(stateFile, { maxBytes: 64 });
    assert.throws(() => bounded.load(), ThreadRegistryStateInvalidError);

    const tiny = new JsonFileThreadRegistryStore(stateFile, { maxBytes: 32 });
    assert.throws(
      () =>
        tiny.save([
          {
            threadHandle: createThreadHandle("tw_a"),
            conversationLocator: createConversationLocator("https://chatgpt.com/c/synthetic-a"),
          },
        ]),
      ThreadRegistryStateInvalidError,
    );
  });
});

test("M9 store normalizes filesystem failures to a stable persistence error", () => {
  withTempState((directory) => {
    const blockingParent = join(directory, "not-a-directory");
    writeFileSync(blockingParent, "synthetic", "utf8");
    const store = new JsonFileThreadRegistryStore(join(blockingParent, "registry.json"));

    assert.throws(
      () =>
        store.save([
          {
            threadHandle: createThreadHandle("tw_a"),
            conversationLocator: createConversationLocator("https://chatgpt.com/c/synthetic-a"),
          },
        ]),
      (error: unknown) =>
        error instanceof ThreadRegistryPersistenceError &&
        error.code === "THREAD_REGISTRY_PERSISTENCE_FAILED" &&
        !error.message.includes("synthetic-a"),
    );
  });
});

test("M9 store creates missing state directories without leaving temp artifacts", () => {
  withTempState((directory) => {
    const nested = join(directory, "nested", "state");
    const stateFile = join(nested, "thread-registry.v1.json");
    const store = new JsonFileThreadRegistryStore(stateFile);

    store.save([
      {
        threadHandle: createThreadHandle("tw_a"),
        conversationLocator: createConversationLocator("https://chatgpt.com/c/synthetic-a"),
      },
    ]);

    assert.deepEqual(readdirSync(nested), ["thread-registry.v1.json"]);
  });
});
