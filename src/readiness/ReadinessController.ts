import { ConversationLocator } from "../domain/ThreadIdentity.js";
import { RuntimeLease } from "../domain/RuntimeGeneration.js";
import {
  CdpReadinessFailedError,
  ExistingRouteReadinessTimeoutError,
  OperationAbortedError,
  OperationTimeoutError,
  RuntimeGenerationChangedError,
} from "../domain/errors.js";
import { delay, throwIfAborted, withTimeout } from "../utils/timeout.js";
import { ExistingReadinessPolicy } from "./ExistingReadinessPolicy.js";
import { ExistingReadinessObservationPort } from "./types.js";

export const DEFAULT_EXISTING_READINESS_TIMEOUT_MS = 20_000;
export const DEFAULT_EXISTING_READINESS_POLL_INTERVAL_MS = 100;

export interface ReadinessControllerOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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

export class ReadinessController {
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  public constructor(
    private readonly observation: ExistingReadinessObservationPort,
    private readonly policy: ExistingReadinessPolicy = new ExistingReadinessPolicy(),
    options: ReadinessControllerOptions = {},
  ) {
    this.timeoutMs = positiveFinite(
      options.timeoutMs ?? DEFAULT_EXISTING_READINESS_TIMEOUT_MS,
      "timeoutMs",
    );
    this.pollIntervalMs = nonNegativeFinite(
      options.pollIntervalMs ?? DEFAULT_EXISTING_READINESS_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.sleep = options.sleep ?? delay;
  }

  public async waitForExistingRoute(
    expectedLocator: ConversationLocator,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);

    try {
      await withTimeout(
        async (deadlineSignal) => {
          const gate = this.policy.createGate();
          while (true) {
            throwIfAborted(deadlineSignal);
            const snapshot = await this.observation.getReadinessSnapshot(
              expectedLocator,
              lease,
              deadlineSignal,
            );
            const action = gate.observe(snapshot);

            if (action.kind === "READY") {
              return;
            }

            if (action.kind === "FOCUS") {
              await this.observation.focusBackendNode(
                action.backendDOMNodeId,
                lease,
                deadlineSignal,
              );
            }

            await this.sleep(this.pollIntervalMs, deadlineSignal);
          }
        },
        this.timeoutMs,
        signal
          ? { signal, message: "Timed out waiting for existing-route readiness." }
          : { message: "Timed out waiting for existing-route readiness." },
      );
    } catch (error) {
      if (
        error instanceof OperationAbortedError ||
        error instanceof RuntimeGenerationChangedError ||
        error instanceof CdpReadinessFailedError
      ) {
        throw error;
      }
      if (error instanceof OperationTimeoutError) {
        throw new ExistingRouteReadinessTimeoutError(undefined, { cause: error });
      }
      throw new CdpReadinessFailedError(undefined, { cause: error });
    }
  }
}
