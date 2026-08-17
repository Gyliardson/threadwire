import {
  CdpTurnObservationHandle,
  CdpTurnObservationSnapshot,
  CdpWriteLifecycleState,
} from "../cdp/CdpTransport.js";
import { RuntimeLease } from "../domain/RuntimeGeneration.js";
import {
  CdpDisconnectedError,
  FreshConversationNotCreatedError,
  OperationAbortedError,
  OperationTimeoutError,
  RuntimeGenerationChangedError,
  TurnInputFailedError,
  TurnStateUncertainError,
  TurnWriteFailedError,
} from "../domain/errors.js";
import { ConversationLocator } from "../domain/ThreadIdentity.js";
import { RouteExpectation } from "../readiness/types.js";
import { OperationScheduler } from "../routing/OperationScheduler.js";
import { ThreadRegistry } from "../routing/ThreadRegistry.js";
import { delay, throwIfAborted, withTimeout } from "../utils/timeout.js";
import {
  ExistingTurnResult,
  FreshTurnResult,
  TurnCdpPort,
  TurnComposerPreflightPort,
  TurnResult,
  TurnTarget,
} from "./types.js";

export const DEFAULT_TURN_COMMAND_TIMEOUT_MS = 5_000;
export const DEFAULT_TURN_WRITE_OBSERVATION_TIMEOUT_MS = 15_000;
export const DEFAULT_TURN_WRITE_SETTLEMENT_TIMEOUT_MS = 120_000;
export const DEFAULT_FRESH_CONVERSATION_TIMEOUT_MS = 15_000;
export const DEFAULT_TURN_POLL_INTERVAL_MS = 25;

export interface TurnExecutorOptions {
  readonly commandTimeoutMs?: number;
  readonly writeObservationTimeoutMs?: number;
  readonly writeSettlementTimeoutMs?: number;
  readonly freshConversationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`);
  }
  return value;
}

function operationAborted(signal?: AbortSignal): OperationAbortedError {
  return new OperationAbortedError(
    undefined,
    signal?.reason === undefined ? undefined : { cause: signal.reason },
  );
}

function sanitizedTurnCause(error: unknown): Error {
  if (error instanceof CdpDisconnectedError) {
    return new CdpDisconnectedError(error.message);
  }
  if (error instanceof OperationTimeoutError) {
    return new OperationTimeoutError(error.message);
  }
  return new Error("A low-level turn operation failed without retained protocol metadata.");
}

export class TurnExecutor {
  private readonly commandTimeoutMs: number;
  private readonly writeObservationTimeoutMs: number;
  private readonly writeSettlementTimeoutMs: number;
  private readonly freshConversationTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  public constructor(
    private readonly registry: ThreadRegistry,
    private readonly scheduler: OperationScheduler,
    private readonly preflight: TurnComposerPreflightPort,
    private readonly cdp: TurnCdpPort,
    options: TurnExecutorOptions = {},
  ) {
    this.commandTimeoutMs = positiveFinite(
      options.commandTimeoutMs ?? DEFAULT_TURN_COMMAND_TIMEOUT_MS,
      "commandTimeoutMs",
    );
    this.writeObservationTimeoutMs = positiveFinite(
      options.writeObservationTimeoutMs ?? DEFAULT_TURN_WRITE_OBSERVATION_TIMEOUT_MS,
      "writeObservationTimeoutMs",
    );
    this.writeSettlementTimeoutMs = positiveFinite(
      options.writeSettlementTimeoutMs ?? DEFAULT_TURN_WRITE_SETTLEMENT_TIMEOUT_MS,
      "writeSettlementTimeoutMs",
    );
    this.freshConversationTimeoutMs = positiveFinite(
      options.freshConversationTimeoutMs ?? DEFAULT_FRESH_CONVERSATION_TIMEOUT_MS,
      "freshConversationTimeoutMs",
    );
    this.pollIntervalMs = nonNegativeFinite(
      options.pollIntervalMs ?? DEFAULT_TURN_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? (async (ms) => await delay(ms));
  }

  public async execute(
    target: TurnTarget,
    text: string,
    signal?: AbortSignal,
  ): Promise<TurnResult> {
    if (typeof text !== "string" || text.length === 0) {
      throw new TurnInputFailedError();
    }

    return await this.scheduler.schedule(
      "TURN",
      async (operationSignal, lease) =>
        await this.executeScheduled(target, text, lease, operationSignal),
      signal ? { signal } : {},
    );
  }

  private async executeScheduled(
    target: TurnTarget,
    text: string,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<TurnResult> {
    const expectedRoute = this.resolveExpectedRoute(target);

    try {
      await this.preflight.waitForTurnComposer(expectedRoute, lease, signal);
      const composer = await withTimeout(
        async () => await this.cdp.getTurnComposerState(expectedRoute, lease),
        this.commandTimeoutMs,
        signal
          ? { signal, message: "Timed out revalidating the turn composer." }
          : { message: "Timed out revalidating the turn composer." },
      );
      if (!composer.expectedRoute || !composer.eligible || !composer.focused || !composer.empty) {
        throw new TurnInputFailedError();
      }
    } catch (error) {
      this.rethrowPreCommit(error);
    }

    let observation: CdpTurnObservationHandle;
    try {
      observation = this.cdp.armTurnObservation(lease);
    } catch (error) {
      this.rethrowPreCommit(error);
    }

    let committed = false;
    let callerCancelled = false;
    const onAbort = (): void => {
      if (committed) {
        callerCancelled = true;
      }
    };
    signal?.addEventListener("abort", onAbort);

    try {
      throwIfAborted(signal);

      try {
        await withTimeout(
          async () => await this.cdp.insertText(text, lease),
          this.commandTimeoutMs,
          { message: "Timed out waiting for the CDP input command." },
        );
      } catch (error) {
        if (error instanceof RuntimeGenerationChangedError) {
          throw error;
        }
        if (error instanceof CdpDisconnectedError || error instanceof OperationTimeoutError) {
          this.failClosed(lease, error);
        }
        this.assertNoObservedPreSubmitWrite(observation, lease);
        throw new TurnInputFailedError();
      }

      // Composition alone is not submission. A real matching write, however,
      // is independent evidence of mutation risk and cannot be discarded.
      this.assertNoObservedPreSubmitWrite(observation, lease);
      throwIfAborted(signal);

      // From this point onward Enter keyDown may have been sent even if the
      // command later rejects, times out, disconnects, or the caller cancels.
      committed = true;
      callerCancelled = signal?.aborted ?? false;

      let keyDownAccepted = false;
      try {
        await withTimeout(
          async () => await this.cdp.dispatchEnterKeyDown(lease),
          this.commandTimeoutMs,
          { message: "Timed out waiting for Enter keyDown." },
        );
        keyDownAccepted = true;
      } catch (error) {
        this.rethrowPostCommitCommand(error, lease);
      }

      if (keyDownAccepted) {
        try {
          await withTimeout(
            async () => await this.cdp.dispatchEnterKeyUp(lease),
            this.commandTimeoutMs,
            { message: "Timed out waiting for Enter keyUp." },
          );
        } catch (error) {
          this.rethrowPostCommitCommand(error, lease);
        }
      }

      return await this.waitForTurnOutcome(
        target,
        observation,
        lease,
        signal,
        callerCancelled,
      );
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.cdp.releaseTurnObservation(observation);
    }
  }

  private async waitForTurnOutcome(
    target: TurnTarget,
    observation: CdpTurnObservationHandle,
    lease: RuntimeLease,
    signal: AbortSignal | undefined,
    initiallyCancelled: boolean,
  ): Promise<TurnResult> {
    const committedAt = this.clock();
    let writeObservedAt: number | null = null;
    let previousLifecycle: CdpWriteLifecycleState | null = null;
    let freshLocator: ConversationLocator | null = null;
    let lastFreshRouteError: Error | null = null;
    let callerCancelled = initiallyCancelled;

    while (true) {
      callerCancelled ||= signal?.aborted ?? false;
      const now = this.clock();
      const snapshot = this.readTurnObservation(observation, lease);
      const write = snapshot.write;

      if (write === null) {
        if (now - committedAt >= this.writeObservationTimeoutMs) {
          this.failClosed(
            lease,
            new Error("The committed turn did not produce an observable write before its engineering deadline."),
          );
        }
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      if (writeObservedAt === null || (previousLifecycle !== "ACTIVE" && write.lifecycle === "ACTIVE")) {
        writeObservedAt = now;
      }
      previousLifecycle = write.lifecycle;

      if (write.lifecycle === "ACTIVE") {
        if (now - writeObservedAt >= this.writeSettlementTimeoutMs) {
          this.failClosed(
            lease,
            new Error("The observed write did not settle before its engineering deadline."),
          );
        }
      } else if (write.lifecycle === "FAILED") {
        // The exact write outcome is known and takes precedence over a later
        // caller cancellation.
        throw new TurnWriteFailedError();
      } else if (target.kind === "THREAD") {
        if (callerCancelled || signal?.aborted) {
          throw operationAborted(signal);
        }
        return Object.freeze({
          kind: "THREAD" as const,
          threadHandle: target.threadHandle,
          created: false as const,
        }) satisfies ExistingTurnResult;
      }

      if (target.kind === "FRESH" && freshLocator === null) {
        try {
          freshLocator = await withTimeout(
            async () => await this.cdp.getCurrentConversationLocator(lease),
            this.commandTimeoutMs,
            { message: "Timed out observing the resulting conversation route." },
          );
        } catch (error) {
          if (error instanceof RuntimeGenerationChangedError) {
            throw error;
          }
          if (error instanceof CdpDisconnectedError && write.lifecycle === "ACTIVE") {
            this.failClosed(lease, error);
          }
          lastFreshRouteError = sanitizedTurnCause(error);
        }

        // Route observation awaited CDP. Re-read the still-armed scoped observer
        // before any FRESH success/failure decision so a late distinct write
        // already delivered to the adapter cannot be missed.
        const afterRoute = this.readTurnObservation(observation, lease).write;
        if (afterRoute === null) {
          this.failClosed(lease, new Error("The committed turn observation became inconsistent."));
        }
        if (afterRoute.lifecycle === "FAILED") {
          throw new TurnWriteFailedError();
        }
        if (afterRoute.lifecycle === "ACTIVE") {
          previousLifecycle = "ACTIVE";
          writeObservedAt = this.clock();
          await this.sleep(this.pollIntervalMs);
          continue;
        }
      }

      callerCancelled ||= signal?.aborted ?? false;
      if (callerCancelled) {
        throw operationAborted(signal);
      }

      if (freshLocator !== null) {
        // This final synchronous observer read is immediately followed by
        // synchronous registration/return; no event callback can interleave
        // before the finally block releases the scoped observation.
        const finalWrite = this.readTurnObservation(observation, lease).write;
        if (finalWrite === null || finalWrite.lifecycle === "ACTIVE") {
          this.failClosed(lease, new Error("The fresh turn write was not terminal at finalization."));
        }
        if (finalWrite.lifecycle === "FAILED") {
          throw new TurnWriteFailedError();
        }

        const registration = this.registry.registerWithStatus(freshLocator);
        if (registration.created) {
          return Object.freeze({
            kind: "THREAD" as const,
            threadHandle: registration.threadHandle,
            created: true as const,
          }) satisfies FreshTurnResult;
        }
        return Object.freeze({
          kind: "THREAD" as const,
          threadHandle: registration.threadHandle,
          created: false as const,
        }) satisfies ExistingTurnResult;
      }

      if (write.lifecycle === "FINISHED" && now - writeObservedAt >= this.freshConversationTimeoutMs) {
        // The current synchronous read proved the selected request terminal and
        // unambiguous immediately before releasing the TURN with this safe failure.
        throw new FreshConversationNotCreatedError(
          undefined,
          lastFreshRouteError === null ? undefined : { cause: lastFreshRouteError },
        );
      }

      await this.sleep(this.pollIntervalMs);
    }
  }

  private assertNoObservedPreSubmitWrite(
    observation: CdpTurnObservationHandle,
    lease: RuntimeLease,
  ): void {
    const snapshot = this.readTurnObservation(observation, lease);
    if (snapshot.write === null) {
      return;
    }
    if (snapshot.write.lifecycle === "ACTIVE") {
      this.failClosed(
        lease,
        new Error("A conversation write was observed before the intended submission boundary."),
      );
    }
    // A terminal pre-submit write is navigation-safe, but it cannot prove that
    // this turn followed the intended submission sequence.
    throw new TurnInputFailedError();
  }

  private readTurnObservation(
    observation: CdpTurnObservationHandle,
    lease: RuntimeLease,
  ): CdpTurnObservationSnapshot {
    try {
      return this.cdp.getTurnObservation(observation, lease);
    } catch (error) {
      if (error instanceof RuntimeGenerationChangedError) {
        throw error;
      }
      this.failClosed(lease, error);
    }
  }

  private resolveExpectedRoute(target: TurnTarget): RouteExpectation {
    if (target.kind === "THREAD") {
      return { kind: "THREAD", locator: this.registry.resolve(target.threadHandle) };
    }
    if (target.kind === "FRESH") {
      return { kind: "FRESH_ROOT" };
    }
    throw new TurnInputFailedError();
  }

  private rethrowPreCommit(error: unknown): never {
    if (
      error instanceof RuntimeGenerationChangedError ||
      error instanceof OperationAbortedError ||
      error instanceof CdpDisconnectedError ||
      error instanceof TurnInputFailedError
    ) {
      throw error;
    }
    // Unknown low-level/protocol/library errors may retain command parameters.
    // Do not keep them in the outward cause graph.
    throw new TurnInputFailedError();
  }

  private rethrowPostCommitCommand(error: unknown, lease: RuntimeLease): void {
    if (error instanceof RuntimeGenerationChangedError) {
      throw error;
    }
    if (error instanceof CdpDisconnectedError || error instanceof OperationTimeoutError) {
      this.failClosed(lease, error);
    }
    // A generic key event rejection is weaker evidence than a subsequently
    // observed, unambiguous legitimate write reaching successful settlement.
    // The raw error object is deliberately discarded.
  }

  private failClosed(lease: RuntimeLease, cause: unknown): never {
    this.scheduler.markRuntimeMutationStateUncertain(lease);
    throw new TurnStateUncertainError(undefined, { cause: sanitizedTurnCause(cause) });
  }
}
