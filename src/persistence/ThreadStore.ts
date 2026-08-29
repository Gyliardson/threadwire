import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConversationLocator, ThreadHandle } from "../domain/ThreadIdentity.js";
import { ThreadStoreInvalidError, ThreadStoreUnavailableError } from "./errors.js";

export const THREAD_STORE_SCHEMA_VERSION = 1;
export const DEFAULT_THREAD_STORE_BUSY_TIMEOUT_MS = 5_000;

const THREADS_TABLE_SQL = `CREATE TABLE threads (
  thread_handle TEXT PRIMARY KEY NOT NULL,
  conversation_locator TEXT NOT NULL UNIQUE
)`;

export type PersistedThreadRecord = Readonly<{
  threadHandle: string;
  conversationLocator: string;
}>;

export interface ThreadPersistencePort {
  load(): readonly PersistedThreadRecord[];
  insert(threadHandle: ThreadHandle, conversationLocator: ConversationLocator): void;
  close(): void;
}

function normalizeSchemaSql(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function invalidStore(): ThreadStoreInvalidError {
  return new ThreadStoreInvalidError();
}

export class SqliteThreadStore implements ThreadPersistencePort {
  private database: DatabaseSync | null = null;

  public constructor(databasePath: string) {
    let database: DatabaseSync;
    try {
      mkdirSync(dirname(databasePath), { recursive: true });
      database = new DatabaseSync(databasePath, {
        timeout: DEFAULT_THREAD_STORE_BUSY_TIMEOUT_MS,
      });
    } catch {
      throw new ThreadStoreUnavailableError();
    }

    this.database = database;
    try {
      this.assertIntegrity();
    } catch {
      this.closeWithoutThrowing();
      throw invalidStore();
    }

    try {
      const journalMode = database.prepare("PRAGMA journal_mode = WAL").get();
      if (
        typeof journalMode !== "object" ||
        journalMode === null ||
        Array.isArray(journalMode) ||
        (journalMode as Record<string, unknown>).journal_mode !== "wal"
      ) {
        throw new Error("WAL mode was not enabled.");
      }
      database.exec("PRAGMA synchronous = FULL;");
      database.exec("PRAGMA foreign_keys = ON;");
      database.exec("PRAGMA trusted_schema = OFF;");
    } catch {
      this.closeWithoutThrowing();
      throw new ThreadStoreUnavailableError();
    }

    try {
      this.initializeSchema();
      this.assertSchema();
    } catch (error) {
      this.closeWithoutThrowing();
      if (error instanceof ThreadStoreInvalidError) {
        throw error;
      }
      throw invalidStore();
    }
  }

  public load(): readonly PersistedThreadRecord[] {
    const database = this.assertOpen();
    let rows: unknown[];
    try {
      rows = database
        .prepare(
          "SELECT thread_handle AS threadHandle, conversation_locator AS conversationLocator FROM threads ORDER BY thread_handle",
        )
        .all();
    } catch {
      throw invalidStore();
    }

    const records = rows.map((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw invalidStore();
      }
      const row = value as Record<string, unknown>;
      if (typeof row.threadHandle !== "string" || typeof row.conversationLocator !== "string") {
        throw invalidStore();
      }
      return Object.freeze({
        threadHandle: row.threadHandle,
        conversationLocator: row.conversationLocator,
      });
    });
    return Object.freeze(records);
  }

  public insert(threadHandle: ThreadHandle, conversationLocator: ConversationLocator): void {
    const database = this.assertOpen();
    try {
      database.exec("BEGIN IMMEDIATE;");
      database
        .prepare("INSERT INTO threads(thread_handle, conversation_locator) VALUES (?, ?)")
        .run(threadHandle, conversationLocator);
      database.exec("COMMIT;");
    } catch {
      if (database.isTransaction) {
        try {
          database.exec("ROLLBACK;");
        } catch {
          // The original durable-write failure remains authoritative.
        }
      }
      throw new ThreadStoreUnavailableError();
    }
  }

  public close(): void {
    const database = this.database;
    this.database = null;
    if (database === null) {
      return;
    }
    try {
      database.close();
    } catch {
      throw new ThreadStoreUnavailableError();
    }
  }

  private assertOpen(): DatabaseSync {
    if (this.database === null || !this.database.isOpen) {
      throw new ThreadStoreUnavailableError();
    }
    return this.database;
  }

  private assertIntegrity(): void {
    const rows = this.assertOpen().prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1) {
      throw invalidStore();
    }
    const row = rows[0];
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw invalidStore();
    }
    if ((row as Record<string, unknown>).integrity_check !== "ok") {
      throw invalidStore();
    }
  }

  private initializeSchema(): void {
    const database = this.assertOpen();
    const versionRow = database.prepare("PRAGMA user_version").get();
    if (
      typeof versionRow !== "object" ||
      versionRow === null ||
      Array.isArray(versionRow) ||
      !Number.isInteger((versionRow as Record<string, unknown>).user_version)
    ) {
      throw invalidStore();
    }
    const version = (versionRow as { user_version: number }).user_version;

    const userTables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();

    if (version === 0) {
      if (userTables.length !== 0) {
        throw invalidStore();
      }
      try {
        database.exec("BEGIN IMMEDIATE;");
        database.exec(`${THREADS_TABLE_SQL};`);
        database.exec(`PRAGMA user_version = ${THREAD_STORE_SCHEMA_VERSION};`);
        database.exec("COMMIT;");
      } catch {
        if (database.isTransaction) {
          try {
            database.exec("ROLLBACK;");
          } catch {
            // The failed initialization remains authoritative.
          }
        }
        throw invalidStore();
      }
      return;
    }

    if (version !== THREAD_STORE_SCHEMA_VERSION) {
      throw invalidStore();
    }
  }

  private assertSchema(): void {
    const database = this.assertOpen();
    const row = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'threads'")
      .get();
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw invalidStore();
    }
    const sql = (row as Record<string, unknown>).sql;
    if (typeof sql !== "string" || normalizeSchemaSql(sql) !== normalizeSchemaSql(THREADS_TABLE_SQL)) {
      throw invalidStore();
    }
  }

  private closeWithoutThrowing(): void {
    const database = this.database;
    this.database = null;
    if (database === null) {
      return;
    }
    try {
      database.close();
    } catch {
      // Constructor failure remains authoritative and intentionally sanitized.
    }
  }
}
