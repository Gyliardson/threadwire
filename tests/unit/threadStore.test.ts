import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { TestContext } from "node:test";
import { createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import {
  THREAD_STORE_SCHEMA_VERSION,
  SqliteThreadStore,
} from "../../src/persistence/ThreadStore.js";
import {
  ThreadStoreInvalidError,
  ThreadStoreUnavailableError,
} from "../../src/persistence/errors.js";
import { ThreadRegistry } from "../../src/routing/ThreadRegistry.js";

function databasePath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "threadwire-m9-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "state.sqlite3");
}

test("fresh store creates an empty versioned schema", (t) => {
  const path = databasePath(t);
  const store = new SqliteThreadStore(path);
  assert.deepEqual(store.load(), []);
  store.close();

  const database = new DatabaseSync(path, { readOnly: true });
  const version = database.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(version.user_version, THREAD_STORE_SCHEMA_VERSION);
  database.close();
});

test("registered handles survive close and reopen with the same locator mapping", (t) => {
  const path = databasePath(t);
  const locator = createConversationLocator("https://chatgpt.com/c/synthetic-persisted-thread");

  const first = new ThreadRegistry({
    handleFactory: () => "persisted-handle",
    persistence: new SqliteThreadStore(path),
  });
  const handle = first.register(locator);
  assert.equal(handle, "tw_persisted-handle");
  first.close();

  const second = new ThreadRegistry({
    handleFactory: () => "must-not-be-used",
    persistence: new SqliteThreadStore(path),
  });
  assert.deepEqual(second.knownThreads(), [handle]);
  assert.equal(second.resolve(handle), locator);
  assert.equal(second.register(locator), handle);
  second.close();
});

test("unsupported schema version fails closed without resetting state", (t) => {
  const path = databasePath(t);
  const database = new DatabaseSync(path);
  database.exec("PRAGMA user_version = 99;");
  database.close();

  assert.throws(() => new SqliteThreadStore(path), ThreadStoreInvalidError);

  const reopened = new DatabaseSync(path, { readOnly: true });
  const version = reopened.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(version.user_version, 99);
  reopened.close();
});

test("schema mismatch at a supported version fails closed", (t) => {
  const path = databasePath(t);
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE wrong_table(value TEXT);");
  database.exec(`PRAGMA user_version = ${THREAD_STORE_SCHEMA_VERSION};`);
  database.close();

  assert.throws(() => new SqliteThreadStore(path), ThreadStoreInvalidError);
});

test("persisted identities are revalidated before entering the registry", (t) => {
  const path = databasePath(t);
  const store = new SqliteThreadStore(path);
  store.close();

  const database = new DatabaseSync(path);
  database
    .prepare("INSERT INTO threads(thread_handle, conversation_locator) VALUES (?, ?)")
    .run("not-a-thread-handle", "https://chatgpt.com/c/synthetic-invalid-handle");
  database.close();

  assert.throws(
    () => new ThreadRegistry({ persistence: new SqliteThreadStore(path) }),
    ThreadStoreInvalidError,
  );
});

test("corrupt database bytes never degrade silently to an empty registry", (t) => {
  const path = databasePath(t);
  const corruptBytes = Buffer.from("not a sqlite database", "utf8");
  writeFileSync(path, corruptBytes);

  assert.throws(
    () => new SqliteThreadStore(path),
    (error: unknown) =>
      error instanceof ThreadStoreInvalidError || error instanceof ThreadStoreUnavailableError,
  );
  assert.deepEqual(readFileSync(path), corruptBytes);
});
