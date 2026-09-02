import {
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
  ProjectConversationNotCreatedError,
  RuntimeGenerationChangedError,
  ResponseParseFailedError,
  ResponseStreamFailedError,
  ResponseStreamUnavailableError,
  ThreadwireError,
  TurnInputFailedError,
  TurnStateUncertainError,
  TurnWriteFailedError,
} from "../domain/errors.js";
import {
  ConversationLocator,
  conversationBelongsToProject,
  isUnscopedConversationLocator,
} from "../domain/ThreadIdentity.js";
import { RouteExpectation } from "../readiness/types.js";
import { NormalizedResponseStreamEvent } from "../response/types.js";
import { OperationScheduler } from "../routing/OperationScheduler.js";
import {
  ProvisionalThreadRegistrationResult,
  ProvisionalThreadRegistrationToken,
  ThreadRegistrationResult,
  ThreadRegistry,
} from "../routing/ThreadRegistry.js";
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
export const DEFAULT_MAX_ACCUMULATED_FINAL_TEXT_CHARS = 1_048_576;
export const DEFAULT_FRESH_CONVERSATION_TIMEOUT_MS = 15_000;
export const DEFAULT_TURN_POLL_INTERVAL_MS = 25;

export interface TurnExecutorOptions {
  readonly commandTimeoutMs?: number;
  readonly writeObservationTimeoutMs?: number;
  readonly writeSettlementTimeoutMs?: number;
  readonly responseCompletionTimeoutMs?: number;
  readonly maxAccumulatedTextChars?: number;
  readonly freshConversationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface ResponseDeliveryState {
  readonly listener: TurnResponseEventListener;
  deliveryDeferred: boolean;
  semanticCompleted: boolean;
  finalized: boolean;
  terminalError: ThreadwireError | null;
  discarded: boolean;
  accumulatedText: string;
}

interface PendingProjectCompletion {
  readonly lease: RuntimeLease;
  readonly transaction: ProvisionalThreadRegistrationToken;
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

function mutationTimeoutOptions(
  cdp: TurnCdpPort,
  signal: AbortSignal | undefined,
  message: string,
): Readonly<{ signal?: AbortSignal; message: string }> {
  return cdp.boundMutationCancellation === true && signal
    ? { signal, message }
    : { message };
}

export class TurnExecutor {
  private readonly pendingProjectCompletions = new WeakMap<TurnResult, PendingProjectCompletion>();
  private readonly commandTimeoutMs: number;
  private readonly writeObservationTimeoutMs: number;
  private readonly writeSettlementTimeoutMs: number;
  private readonly responseCompletionTimeoutMs: number;
  private readonly maxAccumulatedTextChars: number;
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
    this.maxAccumulatedTextChars = positiveFinite(
      options.maxAccumulatedTextChars ?? DEFAULT_MAX_ACCUMULATED_FINAL_TEXT_CHARS,
      "maxAccumulatedTextChars",
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

  public confirmCompletedTurn(result: TurnResult): void {
    const pending = this.pendingProjectCompletions.get(result);
    if (pending === undefined) return;
    this.pendingProjectCompletions.delete(result);
    this.registry.commitProvisional(pending.transaction);
  }

  public rollbackCompletedTurn(result: TurnResult): void {
    const pending = this.pendingProjectCompletions.get(result);
    if (pending === undefined) {
      return;
    }
    this.pendingProjectCompletions.delete(result);
    if (this.registry.rollbackProvisional(pending.transaction)) {
      this.scheduler.markRuntimeMutationStateUncertain(pending.lease);
    }
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
    let projectComposerBackendDOMNodeId: number | null = null;

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
      if (
        responseListener !== undefined &&
        (typeof this.cdp.takeTurnResponseEvents !== "function" ||
          typeof this.cdp.discardTurnResponse !== "function")
      ) {
        throw new ResponseStreamUnavailableError();
      }
      if (target.kind === "PROJECT") {
        if (
          typeof this.cdp.insertTextIntoProjectComposer !== "function" ||
          typeof this.cdp.clickTurnSendButton !== "function"
        ) {
          throw new TurnInputFailedError();
        }
        const backendDOMNodeId = composer.backendDOMNodeId;
        if (!Number.isSafeInteger(backendDOMNodeId) || backendDOMNodeId === undefined || backendDOMNodeId <= 0) {
          throw new TurnInputFailedError();
        }
        projectComposerBackendDOMNodeId = backendDOMNodeId;
      } else if (target.kind === "THREAD") {
        if (typeof this.cdp.clickExistingTurnSendButton !== "function") {
          throw new TurnInputFailedError();
        }
        const backendDOMNodeId = composer.backendDOMNodeId;
        if (!Number.isSafeInteger(backendDOMNodeId) || backendDOMNodeId === undefined || backendDOMNodeId <= 0) {
          throw new TurnInputFailedError();
        }
        projectComposerBackendDOMNodeId = backendDOMNodeId;
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

    let responseState: ResponseDeliveryState | null = null;
    let committed = false;
    let callerCancelled = false;
    let projectComposerFormBackendDOMNodeId: number | null = null;
    const onAbort = (): void => {
      if (committed) {
        callerCancelled = true;
      }
    };
    signal?.addEventListener("abort", onAbort);

    try {
      throwIfAborted(signal);

      if (responseListener !== undefined) {
        this.assertNoObservedPreSubmitWrite(observation, lease);
        responseState = {
          listener: responseListener,
          deliveryDeferred: target.kind === "PROJECT",
          semanticCompleted: false,
          finalized: false,
          terminalError: null,
          discarded: false,
          accumulatedText: "",
        };
      }

      throwIfAborted(signal);

      try {
        if (target.kind === "PROJECT") {
          projectComposerFormBackendDOMNodeId = await withTimeout(
            async (commandSignal) => await this.cdp.insertTextIntoProjectComposer!.call(
              this.cdp,
              text,
              target.projectLocator,
              projectComposerBackendDOMNodeId!,
              lease,
              commandSignal,
            ),
            this.commandTimeoutMs,
            mutationTimeoutOptions(
              this.cdp,
              signal,
              "Timed out waiting for the Project input command.",
            ),
          );
        } else {
          await withTimeout(
            async (commandSignal) => await this.cdp.insertText(text, lease, commandSignal),
            this.commandTimeoutMs,
            mutationTimeoutOptions(
              this.cdp,
              signal,
              "Timed out waiting for the CDP input command.",
            ),
          );
        }
      } catch (error) {
        if (error instanceof RuntimeGenerationChangedError) {
          throw error;
        }
        if (target.kind === "PROJECT") {
          this.failClosed(lease, error);
        }
        if (error instanceof CdpDisconnectedError || error instanceof OperationTimeoutError) {
          this.failClosed(lease, error);
        }
        this.assertNoObservedPreSubmitWrite(observation, lease);
        throw new TurnInputFailedError();
      }

      this.assertNoObservedPreSubmitWrite(observation, lease, target.kind === "PROJECT");
      if (target.kind === "PROJECT" && signal?.aborted) {
        this.failClosed(lease, operationAborted(signal));
      }
      throwIfAborted(signal);

      committed = true;
      callerCancelled = signal?.aborted ?? false;

      if (target.kind === "PROJECT") {
        try {
          await withTimeout(
            async (commandSignal) =>
              await this.cdp.clickTurnSendButton!.call(
                this.cdp,
                target.projectLocator,
                projectComposerBackendDOMNodeId!,
                projectComposerFormBackendDOMNodeId!,
                text,
                lease,
                commandSignal,
              ),
            this.commandTimeoutMs,
            mutationTimeoutOptions(
              this.cdp,
              signal,
              "Timed out waiting for the Project turn send control.",
            ),
          );
        } catch (error) {
          if (error instanceof RuntimeGenerationChangedError) {
            throw error;
          }
          this.failClosed(lease, error);
        }
      } else if (target.kind === "THREAD") {
        if (expectedRoute.kind !== "THREAD") this.failClosed(lease, new TurnInputFailedError());
        try {
          await withTimeout(
            async (commandSignal) =>
              await this.cdp.clickExistingTurnSendButton!.call(
                this.cdp,
                expectedRoute.locator,
                projectComposerBackendDOMNodeId!,
                text,
                lease,
                commandSignal,
              ),
            this.commandTimeoutMs,
            mutationTimeoutOptions(
              this.cdp,
              signal,
              "Timed out waiting for the existing-thread send control.",
            ),
          );
        } catch (error) {
          this.rethrowPostCommitCommand(error, lease);
        }
      } else {
        let keyDownAccepted = false;
        try {
          await withTimeout(
            async (commandSignal) => await this.cdp.dispatchEnterKeyDown(lease, commandSignal),
            this.commandTimeoutMs,
            mutationTimeoutOptions(this.cdp, signal, "Timed out waiting for Enter keyDown."),
          );
          keyDownAccepted = true;
        } catch (error) {
          this.rethrowPostCommitCommand(error, lease);
        }

        if (keyDownAccepted) {
          try {
            await withTimeout(
              async (commandSignal) => await this.cdp.dispatchEnterKeyUp(lease, commandSignal),
              this.commandTimeoutMs,
              mutationTimeoutOptions(this.cdp, signal, "Timed out waiting for Enter keyUp."),
            );
          } catch (error) {
            this.rethrowPostCommitCommand(error, lease);
          }
        }
      }

      return await this.waitForTurnOutcome(
        target,
        expectedRoute,
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
    expectedRoute: RouteExpectation,
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
        this.throwWriteFailed(target, lease);
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
          const finalized = this.finalizeResponseDelivery(responseState);
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

      if (target.kind !== "THREAD" && freshLocator === null) {
        try {
          freshLocator = await withTimeout(
            async () => await this.cdp.getCurrentConversationLocator(lease),
            this.commandTimeoutMs,
            { message: "Timed out observing the resulting conversation route." },
          );
          if (
            freshLocator !== null &&
            target.kind === "PROJECT" &&
            !conversationBelongsToProject(freshLocator, target.projectLocator)
          ) {
            freshLocator = null;
          }
          if (
            freshLocator !== null &&
            target.kind === "FRESH" &&
            !isUnscopedConversationLocator(freshLocator)
          ) {
            freshLocator = null;
          }
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
          this.throwWriteFailed(target, lease);
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

      if (target.kind !== "THREAD" && freshLocator !== null && write.lifecycle === "ACTIVE") {
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      callerCancelled ||= signal?.aborted ?? false;
      if (callerCancelled) {
        if (target.kind === "PROJECT") {
          this.failClosed(lease, operationAborted(signal));
        }
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
          if (
            currentFreshLocator !== null &&
            target.kind === "PROJECT" &&
            (!conversationBelongsToProject(currentFreshLocator, target.projectLocator) ||
              currentFreshLocator !== freshLocator)
          ) {
            currentFreshLocator = null;
          }
          if (
            currentFreshLocator !== null &&
            target.kind === "FRESH" &&
            !isUnscopedConversationLocator(currentFreshLocator)
          ) {
            currentFreshLocator = null;
          }
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
          this.throwWriteFailed(target, lease);
        }

        callerCancelled ||= signal?.aborted ?? false;
        if (callerCancelled) {
          if (target.kind === "PROJECT") {
            this.failClosed(lease, operationAborted(signal));
          }
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

          const freshRegistration = target.kind === "PROJECT"
            ? null
            : this.registry.registerWithStatus(currentFreshLocator);
          if (target.kind === "PROJECT" && this.registry.hasLocator(currentFreshLocator)) {
            this.failClosed(lease, new ProjectConversationNotCreatedError());
          }
          if (responseState?.terminalError !== null && responseState?.terminalError !== undefined) {
            if (target.kind === "PROJECT") {
              this.failClosed(lease, responseState.terminalError);
            }
            throw responseState.terminalError;
          }
          if (responseState !== null) {
            const projectRegistration: { value: ProvisionalThreadRegistrationResult | null } = {
              value: null,
            };
            const finalized = this.finalizeResponseDelivery(
              responseState,
              target.kind === "PROJECT"
                ? () => {
                    if (signal?.aborted) {
                      this.failClosed(lease, operationAborted(signal));
                    }
                    projectRegistration.value = this.reserveProjectConversation(
                      currentFreshLocator,
                      lease,
                    );
                  }
                : undefined,
            );
            if (responseState.terminalError !== null) {
              if (projectRegistration.value?.created) {
                this.registry.rollbackProvisional(projectRegistration.value.transaction);
              }
              if (target.kind === "PROJECT") {
                this.failClosed(lease, responseState.terminalError);
              }
              throw responseState.terminalError;
            }
            if (!finalized) {
              await this.sleep(this.pollIntervalMs);
              continue;
            }
            if (projectRegistration.value !== null) {
              if (!projectRegistration.value.created) {
                this.failClosed(lease, new ProjectConversationNotCreatedError());
              }
              return this.createPendingProjectResult(projectRegistration.value, lease);
            }
          }

          if (target.kind === "PROJECT" && responseState === null && signal?.aborted) {
            this.failClosed(lease, operationAborted(signal));
          }

          const registration = freshRegistration ?? this.registerProjectConversation(
            currentFreshLocator,
            lease,
          );

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
          this.throwConversationNotCreated(target, lastFreshRouteError, lease);
        }

        await this.sleep(this.pollIntervalMs);
        continue;
      }

      if (write.lifecycle === "FINISHED" && now - writeObservedAt >= this.freshConversationTimeoutMs) {
        this.throwConversationNotCreated(target, lastFreshRouteError, lease);
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
      if (event.type === "TEXT_DELTA") {
        if (state.accumulatedText.length + event.text.length > this.maxAccumulatedTextChars) {
          state.terminalError ??= new ResponseStreamFailedError();
          this.discardResponse(state, observation, lease, false);
          return;
        }
        if (!state.deliveryDeferred) {
          try {
            state.listener(event);
          } catch {
            state.terminalError ??= new ResponseStreamFailedError();
            this.discardResponse(state, observation, lease, false);
            return;
          }
        }
        state.accumulatedText += event.text;
      }
    }
  }

  private finalizeResponseDelivery(
    state: ResponseDeliveryState,
    beforeCompleted?: () => void,
  ): boolean {
    if (state.finalized) {
      return true;
    }
    if (!state.semanticCompleted || state.terminalError !== null) {
      return false;
    }

    if (state.accumulatedText.trim().length === 0) {
      state.terminalError = new ResponseStreamFailedError();
      return false;
    }

    if (state.deliveryDeferred) {
      try {
        state.listener(Object.freeze({
          type: "TEXT_DELTA" as const,
          text: state.accumulatedText,
        }));
      } catch {
        state.terminalError = new ResponseStreamFailedError();
        return false;
      }
      state.deliveryDeferred = false;
    }

    try {
      state.listener(Object.freeze({ type: "FINAL_TEXT" as const, text: state.accumulatedText }));
    } catch {
      state.terminalError = new ResponseStreamFailedError();
      return false;
    }

    beforeCompleted?.();

    try {
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
    failClosedOnAnyWrite = false,
  ): void {
    const snapshot = this.readTurnObservation(observation, lease);
    if (snapshot.write === null) {
      return;
    }
    if (failClosedOnAnyWrite || snapshot.write.lifecycle === "ACTIVE") {
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
    if (target.kind === "PROJECT") {
      return { kind: "PROJECT_ROOT", locator: target.projectLocator };
    }
    throw new TurnInputFailedError();
  }

  private throwConversationNotCreated(
    target: TurnTarget,
    cause: Error | null,
    lease: RuntimeLease,
  ): never {
    const options = cause === null ? undefined : { cause };
    if (target.kind === "PROJECT") {
      this.failClosed(lease, new ProjectConversationNotCreatedError(undefined, options));
    }
    throw new FreshConversationNotCreatedError(undefined, options);
  }

  private throwWriteFailed(target: TurnTarget, lease: RuntimeLease): never {
    const error = new TurnWriteFailedError();
    if (target.kind === "PROJECT") {
      this.failClosed(lease, error);
    }
    throw error;
  }

  private registerProjectConversation(
    locator: ConversationLocator,
    lease: RuntimeLease,
  ): ThreadRegistrationResult {
    let registration: ThreadRegistrationResult;
    try {
      registration = this.registry.registerWithStatus(locator);
    } catch (error) {
      this.failClosed(lease, error);
    }
    if (!registration.created) {
      this.failClosed(lease, new ProjectConversationNotCreatedError());
    }
    return registration;
  }

  private reserveProjectConversation(
    locator: ConversationLocator,
    lease: RuntimeLease,
  ): ProvisionalThreadRegistrationResult {
    let registration: ProvisionalThreadRegistrationResult;
    try {
      registration = this.registry.reserveProvisionalWithStatus(locator);
    } catch (error) {
      this.failClosed(lease, error);
    }
    if (!registration.created) {
      this.failClosed(lease, new ProjectConversationNotCreatedError());
    }
    return registration;
  }

  private createPendingProjectResult(
    registration: Extract<ProvisionalThreadRegistrationResult, { created: true }>,
    lease: RuntimeLease,
  ): FreshTurnResult {
    const result = Object.freeze({
      kind: "THREAD" as const,
      threadHandle: registration.threadHandle,
      created: true as const,
    }) satisfies FreshTurnResult;
    this.pendingProjectCompletions.set(result, Object.freeze({
      lease,
      transaction: registration.transaction,
    }));
    return result;
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
