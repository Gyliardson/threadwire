import { randomUUID } from "node:crypto";
import {
  ConversationLocator,
  ThreadHandle,
  createConversationLocator,
  createOpaqueThreadHandle,
} from "../domain/ThreadIdentity.js";
import { ThreadHandleCollisionError, ThreadNotFoundError } from "../domain/errors.js";

export const DEFAULT_THREAD_HANDLE_COLLISION_ATTEMPTS = 8;
export type ThreadHandleFactory = () => string;

export interface ThreadRegistryOptions {
  readonly handleFactory?: ThreadHandleFactory;
}

export type ThreadRegistrationResult = Readonly<{
  threadHandle: ThreadHandle;
  created: boolean;
}>;

export class ThreadRegistry {
  private readonly handleToLocator = new Map<ThreadHandle, ConversationLocator>();
  private readonly locatorToHandle = new Map<ConversationLocator, ThreadHandle>();
  private readonly handleFactory: ThreadHandleFactory;

  public constructor(options: ThreadRegistryOptions = {}) {
    this.handleFactory = options.handleFactory ?? randomUUID;
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
}
