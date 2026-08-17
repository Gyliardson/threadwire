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
        async () => await this.cdp.getTurnComposerState(lease),
        this.commandTimeoutMs,
        signal
          ? { signal, message: "Timed out revalidating the turn composer." }
          : { message: "Timed out revalidating the turn composer." },
      );
      if (!composer.eligible || !composer.focused || !composer.empty) {
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
    let inputFailure: TurnInputFailedError | null = null;
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
        committed = true;
        callerCancelled = signal?.aborted ?? false;
      } catch (error) {
        if (error instanceof RuntimeGenerationChangedError) {
          throw error;
        }
        if (error instanceof CdpDisconnectedError || error instanceof OperationTimeoutError) {
          this.failClosed(lease, error);
        }
        throw new TurnInputFailedError(undefined, { cause: error });
      }

      try {
        await withTimeout(
          async () => await this.cdp.dispatchEnterKeyDown(lease),
          this.commandTimeoutMs,
          { message: "Timed out waiting for Enter keyDown." },
        );
      } catch (error) {
        this.rethrowPostCommitCommand(error, lease);
        inputFailure = new TurnInputFailedError(undefined, { cause: error });
      }

      if (inputFailure === null) {
        try {
          await withTimeout(
            async () => await this.cdp.dispatchEnterKeyUp(lease),
            this.commandTimeoutMs,
            { message: "Timed out waiting for Enter keyUp." },
          );
        } catch (error) {
          this.rethrowPostCommitCommand(error, lease);
          inputFailure = new TurnInputFailedError(undefined, { cause: error });
        }
      }

      return await this.waitForTurnOutcome(
        target,
        observation,
        lease,
        signal,
        callerCancelled,
        inputFailure,
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
    inputFailure: TurnInputFailedError | null,
  ): Promise<TurnResult> {
    const committedAt = this.clock();
    let writeObservedAt: number | null = null;
    let writeLifecycle: CdpWriteLifecycleState | null = null;
    let freshLocator: ConversationLocator | null = null;
    let lastFreshRouteError: unknown = null;
    let callerCancelled = initiallyCancelled;

    while (true) {
      callerCancelled ||= signal?.aborted ?? false;
      const now = this.clock();

      if (writeLifecycle === null || writeLifecycle === "ACTIVE") {
        const snapshot = this.readCommittedObservation(observation, lease);
        if (snapshot.write === null) {
          if (now - committedAt >= this.writeObservationTimeoutMs) {
            this.failClosed(
              lease,
              new Error("The committed turn did not produce an observable write before its engineering deadline."),
            );
          }
          await this.sleep(this.pollIntervalMs);
          continue;
        }

        writeObservedAt ??= now;
        writeLifecycle = snapshot.write.lifecycle;
      }

      if (writeObservedAt === null || writeLifecycle === null) {
        this.failClosed(lease, new Error("The committed turn observation became inconsistent."));
      }

      if (writeLifecycle === "ACTIVE") {
        if (now - writeObservedAt >= this.writeSettlementTimeoutMs) {
          this.failClosed(
            lease,
            new Error("The observed write did not settle before its engineering deadline."),
          );
        }
      } else {
        if (callerCancelled || signal?.aborted) {
          throw operationAborted(signal);
        }
        if (writeLifecycle === "FAILED") {
          throw new TurnWriteFailedError();
        }
        if (inputFailure !== null) {
          throw inputFailure;
        }
        if (target.kind === "THREAD") {
          return Object.freeze({
            kind: "THREAD" as const,
            threadHandle: target.threadHandle,
            created: false as const,
          }) satisfies ExistingTurnResult;
        }
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
          if (error instanceof CdpDisconnectedError && writeLifecycle === "ACTIVE") {
            this.failClosed(lease, error);
          }
          lastFreshRouteError = error;
        }
      }

      if (writeLifecycle === "FINISHED" && freshLocator !== null) {
        const threadHandle = this.registry.register(freshLocator);
        return Object.freeze({
          kind: "THREAD" as const,
          threadHandle,
          created: true as const,
        }) satisfies FreshTurnResult;
      }

      if (
        writeLifecycle === "FINISHED" &&
        now - writeObservedAt >= this.freshConversationTimeoutMs
      ) {
        throw new FreshConversationNotCreatedError(
          undefined,
          lastFreshRouteError === null ? undefined : { cause: lastFreshRouteError },
        );
      }

      await this.sleep(this.pollIntervalMs);
    }
  }

  private readCommittedObservation(
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
    throw new TurnInputFailedError(undefined, { cause: error });
  }

  private rethrowPostCommitCommand(error: unknown, lease: RuntimeLease): void {
    if (error instanceof RuntimeGenerationChangedError) {
      throw error;
    }
    if (error instanceof CdpDisconnectedError || error instanceof OperationTimeoutError) {
      this.failClosed(lease, error);
    }
  }

  private failClosed(lease: RuntimeLease, cause: unknown): never {
    this.scheduler.markRuntimeMutationStateUncertain(lease);
    throw new TurnStateUncertainError(undefined, { cause });
  }
}
