import { randomUUID } from "node:crypto";
import {
  ConversationLocator,
  ThreadHandle,
  createConversationLocator,
  createOpaqueThreadHandle,
} from "../domain/ThreadIdentity.js";
import { ThreadHandleCollisionError, ThreadNotFoundError } from "../domain/errors.js";
import { throwIfAborted } from "../utils/timeout.js";

export const DEFAULT_THREAD_HANDLE_COLLISION_ATTEMPTS = 8;
export type ThreadHandleFactory = () => string;

export interface ThreadRegistryOptions {
  readonly handleFactory?: ThreadHandleFactory;
}

export type ThreadRegistrationResult = Readonly<{
  threadHandle: ThreadHandle;
  created: boolean;
}>;

declare const provisionalThreadRegistrationBrand: unique symbol;
export type ProvisionalThreadRegistrationToken = Readonly<{
  readonly [provisionalThreadRegistrationBrand]: true;
}>;

export type ProvisionalThreadRegistrationResult =
  | Readonly<{ threadHandle: ThreadHandle; created: false }>
  | Readonly<{
      threadHandle: ThreadHandle;
      created: true;
      transaction: ProvisionalThreadRegistrationToken;
    }>;

export type ThreadRegistrationState = "COMMITTED" | "PROVISIONAL";

interface ProvisionalThreadEntry {
  readonly locator: ConversationLocator;
  readonly transaction: ProvisionalThreadRegistrationToken;
  readonly settlement: Promise<boolean>;
  readonly settle: (committed: boolean) => void;
}

export class ThreadRegistry {
  private readonly committedHandleToLocator = new Map<ThreadHandle, ConversationLocator>();
  private readonly locatorToHandle = new Map<ConversationLocator, ThreadHandle>();
  private readonly provisionalHandleToEntry = new Map<ThreadHandle, ProvisionalThreadEntry>();
  private readonly provisionalTransactionToHandle = new WeakMap<
    ProvisionalThreadRegistrationToken,
    ThreadHandle
  >();
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
      if (!this.committedHandleToLocator.has(existing)) {
        throw new ThreadNotFoundError();
      }
      return Object.freeze({ threadHandle: existing, created: false });
    }

    for (let attempt = 0; attempt < DEFAULT_THREAD_HANDLE_COLLISION_ATTEMPTS; attempt += 1) {
      const handle = createOpaqueThreadHandle(this.handleFactory());
      if (this.handleExists(handle)) {
        continue;
      }
      this.committedHandleToLocator.set(handle, normalized);
      this.locatorToHandle.set(normalized, handle);
      return Object.freeze({ threadHandle: handle, created: true });
    }

    throw new ThreadHandleCollisionError();
  }

  public reserveProvisionalWithStatus(
    locator: ConversationLocator,
  ): ProvisionalThreadRegistrationResult {
    const normalized = createConversationLocator(locator);
    const existing = this.locatorToHandle.get(normalized);
    if (existing) {
      return Object.freeze({ threadHandle: existing, created: false });
    }

    for (let attempt = 0; attempt < DEFAULT_THREAD_HANDLE_COLLISION_ATTEMPTS; attempt += 1) {
      const threadHandle = createOpaqueThreadHandle(this.handleFactory());
      if (this.handleExists(threadHandle)) {
        continue;
      }
      const transaction = Object.freeze({}) as ProvisionalThreadRegistrationToken;
      let settle!: (committed: boolean) => void;
      const settlement = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      this.provisionalHandleToEntry.set(threadHandle, {
        locator: normalized,
        transaction,
        settlement,
        settle,
      });
      this.provisionalTransactionToHandle.set(transaction, threadHandle);
      this.locatorToHandle.set(normalized, threadHandle);
      return Object.freeze({ threadHandle, created: true, transaction });
    }

    throw new ThreadHandleCollisionError();
  }

  public commitProvisional(transaction: ProvisionalThreadRegistrationToken): boolean {
    const handle = this.provisionalTransactionToHandle.get(transaction);
    if (handle === undefined) return false;
    const entry = this.provisionalHandleToEntry.get(handle);
    if (entry?.transaction !== transaction) return false;

    this.provisionalTransactionToHandle.delete(transaction);
    this.provisionalHandleToEntry.delete(handle);
    this.committedHandleToLocator.set(handle, entry.locator);
    entry.settle(true);
    return true;
  }

  public rollbackProvisional(transaction: ProvisionalThreadRegistrationToken): boolean {
    const handle = this.provisionalTransactionToHandle.get(transaction);
    if (handle === undefined) return false;
    const entry = this.provisionalHandleToEntry.get(handle);
    if (entry?.transaction !== transaction) return false;

    this.provisionalTransactionToHandle.delete(transaction);
    this.provisionalHandleToEntry.delete(handle);
    if (this.locatorToHandle.get(entry.locator) === handle) {
      this.locatorToHandle.delete(entry.locator);
    }
    entry.settle(false);
    return true;
  }

  public registrationState(handle: ThreadHandle): ThreadRegistrationState {
    if (this.committedHandleToLocator.has(handle)) return "COMMITTED";
    if (this.provisionalHandleToEntry.has(handle)) return "PROVISIONAL";
    throw new ThreadNotFoundError();
  }

  public async waitForCommit(handle: ThreadHandle, signal?: AbortSignal): Promise<void> {
    const state = this.registrationState(handle);
    if (state === "COMMITTED") return;
    const entry = this.provisionalHandleToEntry.get(handle);
    if (entry === undefined) throw new ThreadNotFoundError();
    throwIfAborted(signal);

    let onAbort: (() => void) | null = null;
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      onAbort = () => {
        try {
          throwIfAborted(signal);
        } catch (error) {
          reject(error);
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const committed = await Promise.race([entry.settlement, aborted]);
      if (!committed) throw new ThreadNotFoundError();
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  public resolve(handle: ThreadHandle): ConversationLocator {
    const locator = this.committedHandleToLocator.get(handle);
    if (!locator) {
      throw new ThreadNotFoundError();
    }
    return locator;
  }

  public hasLocator(locator: ConversationLocator): boolean {
    return this.locatorToHandle.has(createConversationLocator(locator));
  }

  public knownThreads(): readonly ThreadHandle[] {
    return Object.freeze([...this.committedHandleToLocator.keys()]);
  }

  private handleExists(handle: ThreadHandle): boolean {
    return this.committedHandleToLocator.has(handle) || this.provisionalHandleToEntry.has(handle);
  }
}
