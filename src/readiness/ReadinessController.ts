import { ConversationLocator } from "../domain/ThreadIdentity.js";
import { RuntimeLease } from "../domain/RuntimeGeneration.js";
import {
  CdpReadinessFailedError,
  ExistingRouteReadinessTimeoutError,
  OperationAbortedError,
  OperationTimeoutError,
  RuntimeGenerationChangedError,
} from "../domain/errors.js";
import { delay, throwIfAborted } from "../utils/timeout.js";
import { ExistingReadinessPolicy } from "./ExistingReadinessPolicy.js";
import { ExistingReadinessObservationPort } from "./types.js";

export const DEFAULT_EXISTING_READINESS_TIMEOUT_MS = 20_000;
export const DEFAULT_EXISTING_READINESS_POLL_INTERVAL_MS = 100;

export interface ReadinessDeadlineScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface ReadinessControllerOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly deadlineScheduler?: ReadinessDeadlineScheduler;
}

interface DeadlineSignal {
  readonly signal: AbortSignal;
  dispose(): void;
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

function createDeadlineSignal(
  timeoutMs: number,
  scheduler: ReadinessDeadlineScheduler,
  parent?: AbortSignal,
): DeadlineSignal {
  const controller = new AbortController();
  const timeoutError = new OperationTimeoutError("Timed out waiting for existing-route readiness.");
  const timer = scheduler.schedule(() => controller.abort(timeoutError), timeoutMs);

  const onParentAbort = (): void => {
    controller.abort(
      new OperationAbortedError(
        undefined,
        parent?.reason === undefined ? undefined : { cause: parent.reason },
      ),
    );
  };

  parent?.addEventListener("abort", onParentAbort, { once: true });

  return {
    signal: controller.signal,
    dispose: () => {
      scheduler.cancel(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

export class ReadinessController {
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly deadlineScheduler: ReadinessDeadlineScheduler;

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
    this.deadlineScheduler = options.deadlineScheduler ?? {
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  public async waitForExistingRoute(
    expectedLocator: ConversationLocator,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const deadline = createDeadlineSignal(this.timeoutMs, this.deadlineScheduler, signal);

    try {
      const gate = this.policy.createGate();
      while (true) {
        throwIfAborted(deadline.signal);
        const snapshot = await this.observation.getReadinessSnapshot(
          expectedLocator,
          lease,
          deadline.signal,
        );
        const action = gate.observe(snapshot);

        if (action.kind === "READY") {
          return;
        }

        if (action.kind === "FOCUS") {
          await this.observation.focusBackendNode(
            action.backendDOMNodeId,
            lease,
            deadline.signal,
          );
        }

        await this.sleep(this.pollIntervalMs, deadline.signal);
      }
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
    } finally {
      deadline.dispose();
    }
  }
}
