import { randomUUID } from "node:crypto";
import { ThreadHandleCollisionError, ThreadNotFoundError, ThreadRegistryStateInvalidError } from "../domain/errors.js";
import {
  ConversationLocator,
  ThreadHandle,
  createConversationLocator,
  createOpaqueThreadHandle,
  createThreadHandle,
} from "../domain/ThreadIdentity.js";
import { ThreadRegistryRecord, ThreadRegistryStore } from "../persistence/ThreadRegistryStore.js";

export const DEFAULT_THREAD_HANDLE_COLLISION_ATTEMPTS = 8;
export type ThreadHandleFactory = () => string;

export interface ThreadRegistryOptions {
  readonly handleFactory?: ThreadHandleFactory;
  readonly store?: ThreadRegistryStore;
}

export type ThreadRegistrationResult = Readonly<{
  threadHandle: ThreadHandle;
  created: boolean;
}>;

export class ThreadRegistry {
  private readonly handleToLocator = new Map<ThreadHandle, ConversationLocator>();
  private readonly locatorToHandle = new Map<ConversationLocator, ThreadHandle>();
  private readonly handleFactory: ThreadHandleFactory;
  private readonly store: ThreadRegistryStore | null;

  public constructor(options: ThreadRegistryOptions = {}) {
    this.handleFactory = options.handleFactory ?? randomUUID;
    this.store = options.store ?? null;
    this.restore(this.store?.load() ?? []);
  }

  public register(locator: ConversationLocator): ThreadHandle {
    return this.registerWithStatus(locator).threadHandle;
  }

  public registerWithStatus(locator: ConversationLocator): ThreadRegistrationResult {
    const normalized = createConversationLocator(locator);
    const existing = this.locatorToHandle.get(normalized);
    if (existing) {
      return Object.freeze({ threadHandle: existing, created: false });
    }

    for (let attempt = 0; attempt < DEFAULT_THREAD_HANDLE_COLLISION_ATTEMPTS; attempt += 1) {
      const handle = createOpaqueThreadHandle(this.handleFactory());
      if (this.handleToLocator.has(handle)) {
        continue;
      }

      const nextRecord = Object.freeze({
        threadHandle: handle,
        conversationLocator: normalized,
      }) satisfies ThreadRegistryRecord;
      this.store?.save([...this.snapshotRecords(), nextRecord]);

      this.handleToLocator.set(handle, normalized);
      this.locatorToHandle.set(normalized, handle);
      return Object.freeze({ threadHandle: handle, created: true });
    }

    throw new ThreadHandleCollisionError();
  }

  public resolve(handle: ThreadHandle): ConversationLocator {
    const locator = this.handleToLocator.get(handle);
    if (!locator) {
      throw new ThreadNotFoundError();
    }
    return locator;
  }

  public knownThreads(): readonly ThreadHandle[] {
    return Object.freeze([...this.handleToLocator.keys()]);
  }

  private restore(records: readonly ThreadRegistryRecord[]): void {
    for (const record of records) {
      let threadHandle: ThreadHandle;
      let conversationLocator: ConversationLocator;
      try {
        threadHandle = createThreadHandle(record.threadHandle);
        conversationLocator = createConversationLocator(record.conversationLocator);
      } catch {
        throw new ThreadRegistryStateInvalidError();
      }

      if (
        conversationLocator !== record.conversationLocator ||
        this.handleToLocator.has(threadHandle) ||
        this.locatorToHandle.has(conversationLocator)
      ) {
        throw new ThreadRegistryStateInvalidError();
      }

      this.handleToLocator.set(threadHandle, conversationLocator);
      this.locatorToHandle.set(conversationLocator, threadHandle);
    }
  }

  private snapshotRecords(): readonly ThreadRegistryRecord[] {
    return Object.freeze(
      [...this.handleToLocator.entries()].map(([threadHandle, conversationLocator]) =>
        Object.freeze({ threadHandle, conversationLocator }),
      ),
    );
  }
}
