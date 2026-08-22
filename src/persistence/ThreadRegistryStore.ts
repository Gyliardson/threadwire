import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import {
  ThreadRegistryPersistenceError,
  ThreadRegistryStateInvalidError,
} from "../domain/errors.js";
import {
  ConversationLocator,
  ThreadHandle,
  createConversationLocator,
  createThreadHandle,
} from "../domain/ThreadIdentity.js";

export const THREAD_REGISTRY_STATE_VERSION = 1;
export const DEFAULT_THREAD_REGISTRY_STATE_MAX_BYTES = 1_048_576;
export const DEFAULT_THREAD_REGISTRY_STATE_MAX_ENTRIES = 4_096;

export interface ThreadRegistryRecord {
  readonly threadHandle: ThreadHandle;
  readonly conversationLocator: ConversationLocator;
}

export interface ThreadRegistryStore {
  load(): readonly ThreadRegistryRecord[];
  save(records: readonly ThreadRegistryRecord[]): void;
}

export interface JsonFileThreadRegistryStoreOptions {
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly tempIdFactory?: () => string;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function parseRecords(value: unknown, maxEntries: number): readonly ThreadRegistryRecord[] {
  if (!isObject(value) || !hasExactKeys(value, ["version", "threads"])) {
    throw new ThreadRegistryStateInvalidError();
  }
  if (value.version !== THREAD_REGISTRY_STATE_VERSION || !Array.isArray(value.threads)) {
    throw new ThreadRegistryStateInvalidError();
  }
  if (value.threads.length > maxEntries) {
    throw new ThreadRegistryStateInvalidError();
  }

  const handles = new Set<ThreadHandle>();
  const locators = new Set<ConversationLocator>();
  const records: ThreadRegistryRecord[] = [];

  for (const raw of value.threads) {
    if (!isObject(raw) || !hasExactKeys(raw, ["threadHandle", "conversationLocator"])) {
      throw new ThreadRegistryStateInvalidError();
    }
    if (typeof raw.threadHandle !== "string" || typeof raw.conversationLocator !== "string") {
      throw new ThreadRegistryStateInvalidError();
    }

    let threadHandle: ThreadHandle;
    let conversationLocator: ConversationLocator;
    try {
      threadHandle = createThreadHandle(raw.threadHandle);
      conversationLocator = createConversationLocator(raw.conversationLocator);
    } catch {
      throw new ThreadRegistryStateInvalidError();
    }

    if (conversationLocator !== raw.conversationLocator) {
      throw new ThreadRegistryStateInvalidError();
    }
    if (handles.has(threadHandle) || locators.has(conversationLocator)) {
      throw new ThreadRegistryStateInvalidError();
    }

    handles.add(threadHandle);
    locators.add(conversationLocator);
    records.push(Object.freeze({ threadHandle, conversationLocator }));
  }

  return Object.freeze(records);
}

function encodeRecords(records: readonly ThreadRegistryRecord[], maxEntries: number): string {
  if (records.length > maxEntries) {
    throw new ThreadRegistryStateInvalidError();
  }

  const document = {
    version: THREAD_REGISTRY_STATE_VERSION,
    threads: records.map((record) => ({
      threadHandle: record.threadHandle,
      conversationLocator: record.conversationLocator,
    })),
  };
  return `${JSON.stringify(document)}\n`;
}

export class JsonFileThreadRegistryStore implements ThreadRegistryStore {
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly tempIdFactory: () => string;

  public constructor(
    public readonly stateFile: string,
    options: JsonFileThreadRegistryStoreOptions = {},
  ) {
    if (!isAbsolute(stateFile) || stateFile.includes("\0")) {
      throw new RangeError("stateFile must be an absolute local file path.");
    }
    this.maxBytes = positiveSafeInteger(
      options.maxBytes ?? DEFAULT_THREAD_REGISTRY_STATE_MAX_BYTES,
      "maxBytes",
    );
    this.maxEntries = positiveSafeInteger(
      options.maxEntries ?? DEFAULT_THREAD_REGISTRY_STATE_MAX_ENTRIES,
      "maxEntries",
    );
    this.tempIdFactory = options.tempIdFactory ?? randomUUID;
  }

  public load(): readonly ThreadRegistryRecord[] {
    let stats;
    try {
      stats = lstatSync(this.stateFile);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return Object.freeze([]);
      }
      throw new ThreadRegistryPersistenceError(undefined, { cause: error });
    }

    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > this.maxBytes) {
      throw new ThreadRegistryStateInvalidError();
    }

    let text: string;
    try {
      text = readFileSync(this.stateFile, "utf8");
    } catch (error) {
      throw new ThreadRegistryPersistenceError(undefined, { cause: error });
    }
    if (Buffer.byteLength(text, "utf8") > this.maxBytes) {
      throw new ThreadRegistryStateInvalidError();
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      throw new ThreadRegistryStateInvalidError();
    }
    return parseRecords(decoded, this.maxEntries);
  }

  public save(records: readonly ThreadRegistryRecord[]): void {
    const validated = parseRecords(
      {
        version: THREAD_REGISTRY_STATE_VERSION,
        threads: records.map((record) => ({
          threadHandle: record.threadHandle,
          conversationLocator: record.conversationLocator,
        })),
      },
      this.maxEntries,
    );
    const serialized = encodeRecords(validated, this.maxEntries);
    if (Buffer.byteLength(serialized, "utf8") > this.maxBytes) {
      throw new ThreadRegistryStateInvalidError();
    }

    const stateDirectory = dirname(this.stateFile);
    const tempFile = `${this.stateFile}.${this.tempIdFactory()}.tmp`;
    let descriptor: number | null = null;

    try {
      mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });

      try {
        const existing = lstatSync(this.stateFile);
        if (!existing.isFile() || existing.isSymbolicLink()) {
          throw new ThreadRegistryStateInvalidError();
        }
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          throw error;
        }
      }

      descriptor = openSync(tempFile, "wx", 0o600);
      writeFileSync(descriptor, serialized, { encoding: "utf8" });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(tempFile, this.stateFile);
    } catch (error) {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {
          // Best-effort cleanup only; retain the original persistence error.
        }
      }
      try {
        unlinkSync(tempFile);
      } catch {
        // The temp file may not exist or cleanup may itself fail. Do not replace the original error.
      }
      if (error instanceof ThreadRegistryStateInvalidError) {
        throw error;
      }
      throw new ThreadRegistryPersistenceError(undefined, { cause: error });
    }
  }
}
