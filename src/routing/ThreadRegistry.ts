import { randomUUID } from "node:crypto";
import {
  ConversationLocator,
  ThreadHandle,
  createConversationLocator,
  createOpaqueThreadHandle,
  createThreadHandle,
} from "../domain/ThreadIdentity.js";
import { ThreadHandleCollisionError, ThreadNotFoundError } from "../domain/errors.js";
import { ThreadPersistencePort } from "../persistence/ThreadStore.js";
import {
  ThreadStoreInvalidError,
  ThreadStoreUnavailableError,
} from "../persistence/errors.js";

export const DEFAULT_THREAD_HANDLE_COLLISION_ATTEMPTS = 8;
export type ThreadHandleFactory = () => string;

export interface ThreadRegistryOptions {
  readonly handleFactory?: ThreadHandleFactory;
  readonly persistence?: ThreadPersistencePort;
}

export type ThreadRegistrationResult = Readonly<{
  threadHandle: ThreadHandle;
  created: boolean;
}>;

export class ThreadRegistry {
  private readonly handleToLocator = new Map<ThreadHandle, ConversationLocator>();
  private readonly locatorToHandle = new Map<ConversationLocator, ThreadHandle>();
  private readonly handleFactory: ThreadHandleFactory;
  private readonly persistence: ThreadPersistencePort | undefined;

  public constructor(options: ThreadRegistryOptions = {}) {
    this.handleFactory = options.handleFactory ?? randomUUID;
    this.persistence = options.persistence;

    if (this.persistence !== undefined) {
      try {
        this.hydrate(this.persistence.load());
      } catch (error) {
        try {
          this.persistence.close();
        } catch {
          // The original load/validation failure remains authoritative.
        }
        if (
          error instanceof ThreadStoreInvalidError ||
          error instanceof ThreadStoreUnavailableError
        ) {
          throw error;
        }
        throw new ThreadStoreInvalidError();
      }
    }
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

      this.persistence?.insert(handle, normalized);
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

  public close(): void {
    this.persistence?.close();
  }

  private hydrate(records: ReturnType<ThreadPersistencePort["load"]>): void {
    for (const record of records) {
      let handle: ThreadHandle;
      let locator: ConversationLocator;
      try {
        handle = createThreadHandle(record.threadHandle);
        locator = createConversationLocator(record.conversationLocator);
      } catch {
        throw new ThreadStoreInvalidError();
      }

      if (this.handleToLocator.has(handle) || this.locatorToHandle.has(locator)) {
        throw new ThreadStoreInvalidError();
      }
      this.handleToLocator.set(handle, locator);
      this.locatorToHandle.set(locator, handle);
    }
  }
}
