import { ConversationLocator } from "../domain/ThreadIdentity.js";
import { RuntimeLease, sameRuntimeLease } from "../domain/RuntimeGeneration.js";
import {
  CdpReadinessFailedError,
  ExistingRouteReadinessTimeoutError,
  FreshRouteReadinessTimeoutError,
  OperationAbortedError,
  OperationTimeoutError,
  RuntimeGenerationChangedError,
} from "../domain/errors.js";
import { delay, throwIfAborted } from "../utils/timeout.js";
import { ExistingReadinessPolicy } from "./ExistingReadinessPolicy.js";
import { FreshReadinessPolicy } from "./FreshReadinessPolicy.js";
import {
  ExistingReadinessObservationPort,
  ExistingReadinessSnapshot,
  ReadinessGate,
  RouteExpectation,
} from "./types.js";

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

interface FreshReadinessProof {
  readonly lease: RuntimeLease;
  readonly frameId: string;
  readonly loaderId: string;
  readonly backendDOMNodeId: number;
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
  const timeoutError = new OperationTimeoutError("Timed out waiting for route readiness.");
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
  private freshReadinessProof: FreshReadinessProof | null = null;

  public constructor(
    private readonly observation: ExistingReadinessObservationPort,
    private readonly existingPolicy: ExistingReadinessPolicy = new ExistingReadinessPolicy(),
    private readonly freshPolicy: FreshReadinessPolicy = new FreshReadinessPolicy(),
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
    this.freshReadinessProof = null;
    try {
      await this.waitForRoute(
        this.existingPolicy.createGate(),
        { kind: "THREAD", locator: expectedLocator },
        lease,
        signal,
      );
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        throw new ExistingRouteReadinessTimeoutError(undefined, { cause: error });
      }
      throw error;
    }
  }

  public async waitForFreshRoute(
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    this.freshReadinessProof = null;
    try {
      const snapshot = await this.waitForRoute(
        this.freshPolicy.createGate(),
        { kind: "FRESH_ROOT" },
        lease,
        signal,
      );
      const composer = snapshot.eligibleEditables[0];
      if (composer === undefined) {
        throw new CdpReadinessFailedError();
      }
      this.freshReadinessProof = Object.freeze({
        lease,
        frameId: snapshot.mainFrame.frameId,
        loaderId: snapshot.mainFrame.loaderId,
        backendDOMNodeId: composer.backendDOMNodeId,
      });
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        throw new FreshRouteReadinessTimeoutError(undefined, { cause: error });
      }
      throw error;
    }
  }

  public async waitForTurnComposer(
    expectedRoute: RouteExpectation,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    const snapshot = await this.waitForRoute(
      this.existingPolicy.createGate(),
      expectedRoute,
      lease,
      signal,
    );

    if (expectedRoute.kind === "THREAD") {
      this.freshReadinessProof = null;
      return;
    }

    const proof = this.freshReadinessProof;
    this.freshReadinessProof = null;
    const composer = snapshot.eligibleEditables[0];
    if (
      proof !== null &&
      composer !== undefined &&
      sameRuntimeLease(proof.lease, lease) &&
      proof.frameId === snapshot.mainFrame.frameId &&
      proof.loaderId === snapshot.mainFrame.loaderId &&
      proof.backendDOMNodeId === composer.backendDOMNodeId
    ) {
      return;
    }

    await this.waitForRoute(
      this.freshPolicy.createGate(),
      { kind: "FRESH_ROOT" },
      lease,
      signal,
    );
  }

  private async waitForRoute(
    gate: ReadinessGate,
    expectedRoute: RouteExpectation,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<ExistingReadinessSnapshot> {
    throwIfAborted(signal);
    const deadline = createDeadlineSignal(this.timeoutMs, this.deadlineScheduler, signal);

    try {
      while (true) {
        throwIfAborted(deadline.signal);
        const snapshot = await this.observation.getReadinessSnapshot(
          expectedRoute,
          lease,
          deadline.signal,
        );
        const action = gate.observe(snapshot);

        if (action.kind === "READY") {
          return snapshot;
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
        error instanceof CdpReadinessFailedError ||
        error instanceof OperationTimeoutError
      ) {
        throw error;
      }
      throw new CdpReadinessFailedError(undefined, { cause: error });
    } finally {
      deadline.dispose();
    }
  }
}
