import {
  CdpResponseRenderBaseline,
  CdpResponseStreamFailureKind,
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
  ResponseParseFailedError,
  ResponseStreamFailedError,
  ResponseStreamUnavailableError,
  ThreadwireError,
  TurnInputFailedError,
  TurnStateUncertainError,
  TurnWriteFailedError,
} from "../domain/errors.js";
import { ConversationLocator } from "../domain/ThreadIdentity.js";
import { RouteExpectation } from "../readiness/types.js";
import { NormalizedResponseStreamEvent } from "../response/types.js";
import { OperationScheduler } from "../routing/OperationScheduler.js";
import { ThreadRegistry } from "../routing/ThreadRegistry.js";
import { delay, throwIfAborted, withTimeout } from "../utils/timeout.js";
import {
  ExistingTurnResult,
  FreshTurnResult,
  TurnCdpPort,
  TurnComposerPreflightPort,
  TurnResponseEventListener,
  TurnResult,
  TurnTarget,
} from "./types.js";

export const DEFAULT_TURN_COMMAND_TIMEOUT_MS = 5_000;
export const DEFAULT_TURN_WRITE_OBSERVATION_TIMEOUT_MS = 15_000;
export const DEFAULT_TURN_WRITE_SETTLEMENT_TIMEOUT_MS = 120_000;
export const DEFAULT_TURN_RESPONSE_COMPLETION_TIMEOUT_MS = 120_000;
export const DEFAULT_TURN_FINAL_RESPONSE_SNAPSHOT_TIMEOUT_MS = 15_000;
export const DEFAULT_FRESH_CONVERSATION_TIMEOUT_MS = 15_000;
export const DEFAULT_TURN_POLL_INTERVAL_MS = 25;

export interface TurnExecutorOptions {
  readonly commandTimeoutMs?: number;
  readonly writeObservationTimeoutMs?: number;
  readonly writeSettlementTimeoutMs?: number;
  readonly responseCompletionTimeoutMs?: number;
  readonly finalResponseSnapshotTimeoutMs?: number;
  readonly freshConversationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface ResponseDeliveryState {
  readonly listener: TurnResponseEventListener;
  readonly renderBaseline: CdpResponseRenderBaseline;
  semanticCompleted: boolean;
  finalized: boolean;
  finalizationStartedAt: number | null;
  terminalError: ThreadwireError | null;
  discarded: boolean;
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

function responseErrorForFailure(failure: CdpResponseStreamFailureKind | null): ThreadwireError {
  if (failure === "UNAVAILABLE") {
    return new ResponseStreamUnavailableError();
  }
  if (failure === "PARSE_FAILED") {
    return new ResponseParseFailedError();
  }
  return new ResponseStreamFailedError();
}

export class TurnExecutor {
  private readonly commandTimeoutMs: number;
  private readonly writeObservationTimeoutMs: number;
  private readonly writeSettlementTimeoutMs: number;
  private readonly responseCompletionTimeoutMs: number;
  private readonly finalResponseSnapshotTimeoutMs: number;
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
    this.responseCompletionTimeoutMs = positiveFinite(
      options.responseCompletionTimeoutMs ?? DEFAULT_TURN_RESPONSE_COMPLETION_TIMEOUT_MS,
      "responseCompletionTimeoutMs",
    );
    this.finalResponseSnapshotTimeoutMs = positiveFinite(
      options.finalResponseSnapshotTimeoutMs ?? DEFAULT_TURN_FINAL_RESPONSE_SNAPSHOT_TIMEOUT_MS,
      "finalResponseSnapshotTimeoutMs",
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
    return await this.executeInternal(target, text, undefined, signal);
  }

  public async executeStreaming(
    target: TurnTarget,
    text: string,
    onResponseEvent: TurnResponseEventListener,
    signal?: AbortSignal,
  ): Promise<TurnResult> {
    if (typeof onResponseEvent !== "function") {
      throw new TypeError("onResponseEvent must be a function.");
    }
    return await this.executeInternal(target, text, onResponseEvent, signal);
  }

  private async executeInternal(
    target: TurnTarget,
    text: string,
    responseListener: TurnResponseEventListener | undefined,
    signal?: AbortSignal,
  ): Promise<TurnResult> {
    if (typeof text !== "string" || text.length === 0) {
      throw new TurnInputFailedError();
    }

    return await this.scheduler.schedule(
      "TURN",
      async (operationSignal, lease) =>
        await this.executeScheduled(target, text, lease, operationSignal, responseListener),
      signal ? { signal } : {},
    );
  }

  private async executeScheduled(
    target: TurnTarget,
    text: string,
    lease: RuntimeLease,
    signal: AbortSignal | undefined,
    responseListener: TurnResponseEventListener | undefined,
  ): Promise<TurnResult> {
    const expectedRoute = this.resolveExpectedRoute(target);
    let responseRenderBaseline: CdpResponseRenderBaseline | null = null;

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
      if (responseListener !== undefined) {
        const captureBaseline = this.cdp.captureTurnResponseRenderBaseline;
        const getFinalSnapshot = this.cdp.getFinalRenderedAssistantSnapshot;
        if (
          typeof this.cdp.takeTurnResponseEvents !== "function" ||
          typeof this.cdp.discardTurnResponse !== "function" ||
          typeof captureBaseline !== "function" ||
          typeof getFinalSnapshot !== "function"
        ) {
          throw new ResponseStreamUnavailableError();
        }
        try {
          responseRenderBaseline = await withTimeout(
            async () => await captureBaseline.call(this.cdp, lease),
            this.commandTimeoutMs,
            signal
              ? { signal, message: "Timed out capturing the rendered response baseline." }
              : { message: "Timed out capturing the rendered response baseline." },
          );
        } catch (error) {
          if (
            error instanceof RuntimeGenerationChangedError ||
            error instanceof OperationAbortedError ||
            error instanceof CdpDisconnectedError
          ) {
            throw error;
          }
          throw new ResponseStreamUnavailableError();
        }
      }
    } catch (error) {
      if (error instanceof ResponseStreamUnavailableError) {
        throw error;
      }
      this.rethrowPreCommit(error);
    }

    let observation: CdpTurnObservationHandle;
    try {
      observation = this.cdp.armTurnObservation(
        lease,
        responseListener === undefined ? undefined : { responseStream: true },
      );
    } catch (error) {
      this.rethrowPreCommit(error);
    }

    const responseState: ResponseDeliveryState | null =
      responseListener === undefined
        ? null
        : {
            listener: responseListener,
            renderBaseline: responseRenderBaseline!,
            semanticCompleted: false,
            finalized: false,
            finalizationStartedAt: null,
            terminalError: null,
            discarded: false,
          };

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

      this.assertNoObservedPreSubmitWrite(observation, lease);
      throwIfAborted(signal);

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
        responseState,
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
    responseState: ResponseDeliveryState | null,
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

      this.updateResponseDelivery(
        responseState,
        snapshot,
        observation,
        lease,
        callerCancelled,
      );

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

      this.applyResponseDeadline(responseState, observation, lease, callerCancelled, writeObservedAt, now);

      if (write.lifecycle === "ACTIVE") {
        if (now - writeObservedAt >= this.writeSettlementTimeoutMs) {
          this.failClosed(
            lease,
            new Error("The observed write did not settle before its engineering deadline."),
          );
        }
      } else if (write.lifecycle === "FAILED") {
        throw new TurnWriteFailedError();
      } else if (target.kind === "THREAD") {
        if (callerCancelled || signal?.aborted) {
          throw operationAborted(signal);
        }
        if (responseState !== null) {
          if (responseState.terminalError !== null) {
            throw responseState.terminalError;
          }
          if (!responseState.semanticCompleted) {
            await this.sleep(this.pollIntervalMs);
            continue;
          }
          const finalized = await this.finalizeResponseDelivery(
            responseState,
            expectedRoute,
            lease,
          );
          if (responseState.terminalError !== null) {
            throw responseState.terminalError;
          }
          if (!finalized) {
            await this.sleep(this.pollIntervalMs);
            continue;
          }
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

        const afterRouteSnapshot = this.readTurnObservation(observation, lease);
        this.updateResponseDelivery(
          responseState,
          afterRouteSnapshot,
          observation,
          lease,
          callerCancelled || (signal?.aborted ?? false),
        );
        const afterRoute = afterRouteSnapshot.write;
        if (afterRoute === null) {
          this.failClosed(lease, new Error("The committed turn observation became inconsistent."));
        }
        if (afterRoute.lifecycle === "FAILED") {
          throw new TurnWriteFailedError();
        }
        if (afterRoute.lifecycle === "ACTIVE") {
          if (previousLifecycle !== "ACTIVE") {
            writeObservedAt = this.clock();
          }
          previousLifecycle = "ACTIVE";
          await this.sleep(this.pollIntervalMs);
          continue;
        }
      }

      if (target.kind === "FRESH" && freshLocator !== null && write.lifecycle === "ACTIVE") {
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      callerCancelled ||= signal?.aborted ?? false;
      if (callerCancelled) {
        throw operationAborted(signal);
      }

      if (freshLocator !== null) {
        let currentFreshLocator: ConversationLocator | null = null;
        try {
          currentFreshLocator = await withTimeout(
            async () => await this.cdp.getCurrentConversationLocator(lease),
            this.commandTimeoutMs,
            { message: "Timed out revalidating the resulting conversation route." },
          );
        } catch (error) {
          if (error instanceof RuntimeGenerationChangedError) {
            throw error;
          }
          lastFreshRouteError = sanitizedTurnCause(error);
        }

        const finalSnapshot = this.readTurnObservation(observation, lease);
        this.updateResponseDelivery(
          responseState,
          finalSnapshot,
          observation,
          lease,
          signal?.aborted ?? false,
        );
        const finalWrite = finalSnapshot.write;
        if (finalWrite === null || finalWrite.lifecycle === "ACTIVE") {
          this.failClosed(lease, new Error("The fresh turn write was not terminal at finalization."));
        }
        if (finalWrite.lifecycle === "FAILED") {
          throw new TurnWriteFailedError();
        }

        callerCancelled ||= signal?.aborted ?? false;
        if (callerCancelled) {
          throw operationAborted(signal);
        }

        if (currentFreshLocator !== null) {
          if (
            responseState !== null &&
            responseState.terminalError === null &&
            !responseState.semanticCompleted
          ) {
            await this.sleep(this.pollIntervalMs);
            continue;
          }

          const registration = this.registry.registerWithStatus(currentFreshLocator);
          if (responseState?.terminalError !== null && responseState?.terminalError !== undefined) {
            throw responseState.terminalError;
          }
          if (responseState !== null) {
            const finalized = await this.finalizeResponseDelivery(
              responseState,
              { kind: "THREAD", locator: currentFreshLocator },
              lease,
            );
            if (responseState.terminalError !== null) {
              throw responseState.terminalError;
            }
            if (!finalized) {
              await this.sleep(this.pollIntervalMs);
              continue;
            }
          }

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

        if (this.clock() - writeObservedAt >= this.freshConversationTimeoutMs) {
          throw new FreshConversationNotCreatedError(
            undefined,
            lastFreshRouteError === null ? undefined : { cause: lastFreshRouteError },
          );
        }

        await this.sleep(this.pollIntervalMs);
        continue;
      }

      if (write.lifecycle === "FINISHED" && now - writeObservedAt >= this.freshConversationTimeoutMs) {
        throw new FreshConversationNotCreatedError(
          undefined,
          lastFreshRouteError === null ? undefined : { cause: lastFreshRouteError },
        );
      }

      await this.sleep(this.pollIntervalMs);
    }
  }

  private updateResponseDelivery(
    state: ResponseDeliveryState | null,
    snapshot: CdpTurnObservationSnapshot,
    observation: CdpTurnObservationHandle,
    lease: RuntimeLease,
    callerCancelled: boolean,
  ): void {
    if (state === null) {
      return;
    }

    if (callerCancelled) {
      this.discardResponse(state, observation, lease, true);
      return;
    }

    const response = snapshot.response;
    if (response === undefined) {
      if (state.terminalError === null) {
        state.terminalError = new ResponseStreamUnavailableError();
        this.discardResponse(state, observation, lease, false);
      }
      return;
    }

    if (!state.discarded) {
      this.deliverNormalizedEvents(state, observation, lease);
    }

    if (response.lifecycle === "COMPLETED") {
      state.semanticCompleted = true;
      return;
    }
    if (response.lifecycle === "FAILED" && state.terminalError === null) {
      state.terminalError = responseErrorForFailure(response.failure);
      this.discardResponse(state, observation, lease, false);
    }
  }

  private deliverNormalizedEvents(
    state: ResponseDeliveryState,
    observation: CdpTurnObservationHandle,
    lease: RuntimeLease,
  ): void {
    const take = this.cdp.takeTurnResponseEvents;
    if (typeof take !== "function") {
      state.terminalError ??= new ResponseStreamUnavailableError();
      this.discardResponse(state, observation, lease, false);
      return;
    }

    let events: readonly NormalizedResponseStreamEvent[];
    try {
      events = take.call(this.cdp, observation, lease);
    } catch (error) {
      if (error instanceof RuntimeGenerationChangedError) {
        throw error;
      }
      if (error instanceof CdpDisconnectedError) {
        this.failClosed(lease, error);
      }
      state.terminalError ??= new ResponseStreamFailedError();
      this.discardResponse(state, observation, lease, false);
      return;
    }

    for (const event of events) {
      if (event.type === "COMPLETED") {
        state.semanticCompleted = true;
        continue;
      }
      try {
        state.listener(event);
      } catch {
        state.terminalError ??= new ResponseStreamFailedError();
        this.discardResponse(state, observation, lease, false);
        return;
      }
    }
  }

  private async finalizeResponseDelivery(
    state: ResponseDeliveryState,
    expectedRoute: RouteExpectation,
    lease: RuntimeLease,
  ): Promise<boolean> {
    if (state.finalized) {
      return true;
    }
    if (!state.semanticCompleted || state.terminalError !== null) {
      return false;
    }

    const getFinalSnapshot = this.cdp.getFinalRenderedAssistantSnapshot;
    if (typeof getFinalSnapshot !== "function") {
      state.terminalError = new ResponseStreamUnavailableError();
      return false;
    }

    state.finalizationStartedAt ??= this.clock();
    if (this.clock() - state.finalizationStartedAt >= this.finalResponseSnapshotTimeoutMs) {
      state.terminalError = new ResponseStreamFailedError(
        "The final rendered assistant response did not become safely attributable before the deadline.",
      );
      return false;
    }

    let finalSnapshot: Awaited<ReturnType<NonNullable<TurnCdpPort["getFinalRenderedAssistantSnapshot"]>>>;
    try {
      finalSnapshot = await withTimeout(
        async () => await getFinalSnapshot.call(this.cdp, state.renderBaseline, expectedRoute, lease),
        this.commandTimeoutMs,
        { message: "Timed out reconciling the final rendered assistant response." },
      );
    } catch (error) {
      if (error instanceof RuntimeGenerationChangedError) {
        throw error;
      }
      state.terminalError = new ResponseStreamFailedError();
      return false;
    }

    if (finalSnapshot === null) {
      if (this.clock() - state.finalizationStartedAt >= this.finalResponseSnapshotTimeoutMs) {
        state.terminalError = new ResponseStreamFailedError(
          "The final rendered assistant response did not become safely attributable before the deadline.",
        );
      }
      return false;
    }
    if (typeof finalSnapshot.text !== "string" || finalSnapshot.text.trim().length === 0) {
      state.terminalError = new ResponseStreamFailedError();
      return false;
    }

    try {
      state.listener(Object.freeze({ type: "FINAL_TEXT" as const, text: finalSnapshot.text }));
      state.listener(Object.freeze({ type: "COMPLETED" as const }));
    } catch {
      state.terminalError = new ResponseStreamFailedError();
      return false;
    }

    state.finalized = true;
    return true;
  }

  private applyResponseDeadline(
    state: ResponseDeliveryState | null,
    observation: CdpTurnObservationHandle,
    lease: RuntimeLease,
    callerCancelled: boolean,
    writeObservedAt: number,
    now: number,
  ): void {
    if (
      state === null ||
      callerCancelled ||
      state.semanticCompleted ||
      state.terminalError !== null ||
      now - writeObservedAt < this.responseCompletionTimeoutMs
    ) {
      return;
    }
    state.terminalError = new ResponseStreamFailedError();
    this.discardResponse(state, observation, lease, false);
  }

  private discardResponse(
    state: ResponseDeliveryState,
    observation: CdpTurnObservationHandle,
    lease: RuntimeLease,
    cancellation: boolean,
  ): void {
    if (state.discarded) {
      return;
    }
    state.discarded = true;
    const discard = this.cdp.discardTurnResponse;
    if (typeof discard !== "function") {
      if (!cancellation) {
        state.terminalError ??= new ResponseStreamUnavailableError();
      }
      return;
    }
    try {
      discard.call(this.cdp, observation, lease);
    } catch (error) {
      if (error instanceof RuntimeGenerationChangedError) {
        throw error;
      }
      if (error instanceof CdpDisconnectedError) {
        this.failClosed(lease, error);
      }
      if (!cancellation) {
        state.terminalError ??= new ResponseStreamFailedError();
      }
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
      error instanceof ResponseStreamUnavailableError ||
      error instanceof TurnInputFailedError
    ) {
      throw error;
    }
    throw new TurnInputFailedError();
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
    throw new TurnStateUncertainError(undefined, { cause: sanitizedTurnCause(cause) });
  }
}
