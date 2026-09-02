import { BoundCdpSessionManager } from "../cdp/BoundCdpSessionManager.js";
import { CdpSessionManager } from "../cdp/CdpSessionManager.js";
import { ClassicPolicy, ControllerConfig } from "../config/ControllerConfig.js";
import { ProjectHandle, ProjectLocator } from "../domain/ProjectIdentity.js";
import { RuntimeLease } from "../domain/RuntimeGeneration.js";
import { CdpConnectionState } from "../domain/RuntimeState.js";
import { ThreadHandle } from "../domain/ThreadIdentity.js";
import {
  RequiredExistingRuntimeError,
  RuntimeProvenanceUnverifiedError,
  RuntimeRecoveryForbiddenError,
} from "../domain/errors.js";
import { ProjectCreator } from "../project/ProjectCreator.js";
import { ProjectRegistry } from "../project/ProjectRegistry.js";
import { ReadinessController } from "../readiness/ReadinessController.js";
import { ResponseStreamEvent } from "../response/types.js";
import { ConversationRouter } from "../routing/ConversationRouter.js";
import { OperationScheduler } from "../routing/OperationScheduler.js";
import { ThreadRegistry } from "../routing/ThreadRegistry.js";
import { BoundRuntimeProvenanceGuard } from "../runtime/BoundRuntimeProvenanceGuard.js";
import { WindowsCdpEndpointProvenance } from "../runtime/CdpEndpointProvenance.js";
import { ClassicSupervisor } from "../runtime/ClassicSupervisor.js";
import { TurnExecutor } from "../turn/TurnExecutor.js";
import { TurnResponseEventListener, TurnResult, TurnTarget } from "../turn/types.js";
import { throwIfAborted, withTimeout } from "../utils/timeout.js";
import {
  ControllerTurnQueue,
  DEFAULT_CONTROLLER_MAX_OUTSTANDING_TURNS,
} from "./ControllerTurnQueue.js";

export type ControllerTurnTarget =
  | Readonly<{ kind: "FRESH" }>
  | Readonly<{ kind: "THREAD"; threadHandle: ThreadHandle }>
  | Readonly<{ kind: "PROJECT"; projectHandle: ProjectHandle }>;

export interface ControllerTurnRequest {
  readonly target: ControllerTurnTarget;
  readonly prompt: string;
}

export interface ControllerCreateProjectRequest {
  readonly name: string;
}

export type ControllerCreateProjectResult = Readonly<{ projectHandle: ProjectHandle }>;

export interface ControllerHealth {
  readonly classic: "RUNNING" | "STOPPED";
  readonly cdp: CdpConnectionState;
}

export interface RuntimeControllerPort {
  inspect(signal?: AbortSignal): Promise<Readonly<{ isRunning: boolean }>>;
  ensureStarted(signal?: AbortSignal): Promise<unknown>;
  requireExisting?(signal?: AbortSignal): Promise<RuntimeLease>;
  restart?(signal?: AbortSignal): Promise<unknown>;
}

export interface CdpControllerPort {
  readonly state: CdpConnectionState;
  connect(signal?: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;
  assertCurrentRuntime(): void;
  bindExistingRuntime?(lease: RuntimeLease, signal?: AbortSignal): Promise<void>;
  assertBoundRuntimeCurrent?(lease: RuntimeLease, signal?: AbortSignal): Promise<void>;
}

export interface ThreadRegistryControllerPort {
  resolve(handle: ThreadHandle): unknown;
  registrationState(handle: ThreadHandle): "COMMITTED" | "PROVISIONAL";
  waitForCommit(handle: ThreadHandle, signal?: AbortSignal): Promise<void>;
  knownThreads(): readonly ThreadHandle[];
}

export interface ProjectRegistryControllerPort {
  resolve(handle: ProjectHandle): ProjectLocator;
}

export interface ConversationRouterControllerPort {
  routeFresh(signal?: AbortSignal): Promise<unknown>;
  routeToThread(handle: ThreadHandle, signal?: AbortSignal): Promise<unknown>;
  routeToProject(locator: ProjectLocator, signal?: AbortSignal): Promise<unknown>;
}

export interface TurnExecutorControllerPort {
  executeStreaming(
    target: TurnTarget,
    text: string,
    listener: TurnResponseEventListener,
    signal?: AbortSignal,
  ): Promise<TurnResult>;
  confirmCompletedTurn?(result: TurnResult): void;
  rollbackCompletedTurn?(result: TurnResult): void;
}

export interface ProjectCreatorControllerPort {
  create(name: string, signal?: AbortSignal): Promise<ControllerCreateProjectResult>;
}

export interface ThreadwireControllerDependencies {
  readonly runtime: RuntimeControllerPort;
  readonly cdp: CdpControllerPort;
  readonly registry: ThreadRegistryControllerPort;
  readonly projectRegistry: ProjectRegistryControllerPort;
  readonly router: ConversationRouterControllerPort;
  readonly executor: TurnExecutorControllerPort;
  readonly projectCreator: ProjectCreatorControllerPort;
}

export interface ThreadwireControllerOptions {
  readonly maxOutstandingTurns?: number;
  readonly provisionalThreadWaitTimeoutMs?: number;
  readonly classicPolicy?: ClassicPolicy;
}

export const DEFAULT_PROVISIONAL_THREAD_WAIT_TIMEOUT_MS = 15_000;

interface PendingCompletionBarrier {
  readonly promise: Promise<boolean>;
  readonly settle: (committed: boolean) => void;
}

export class ThreadwireController {
  private readonly turnQueue: ControllerTurnQueue;
  private readonly provisionalThreadWaitTimeoutMs: number;
  private readonly classicPolicy: ClassicPolicy;
  private pendingCompletionBarrier: PendingCompletionBarrier | null = null;
  private readonly pendingCompletionResults = new WeakSet<TurnResult>();
  private boundRuntimeLease: RuntimeLease | null = null;
  private boundAdmission: Promise<void> | null = null;

  public constructor(
    private readonly dependencies: ThreadwireControllerDependencies,
    options: ThreadwireControllerOptions = {},
  ) {
    this.turnQueue = new ControllerTurnQueue(
      options.maxOutstandingTurns ?? DEFAULT_CONTROLLER_MAX_OUTSTANDING_TURNS,
    );
    this.provisionalThreadWaitTimeoutMs =
      options.provisionalThreadWaitTimeoutMs ?? DEFAULT_PROVISIONAL_THREAD_WAIT_TIMEOUT_MS;
    this.classicPolicy = options.classicPolicy ?? "MANAGED";
    if (
      !Number.isFinite(this.provisionalThreadWaitTimeoutMs) ||
      this.provisionalThreadWaitTimeoutMs <= 0
    ) {
      throw new RangeError("provisionalThreadWaitTimeoutMs must be a positive finite number.");
    }
  }

  public async initialize(signal?: AbortSignal): Promise<void> {
    if (this.classicPolicy === "MANAGED") {
      return;
    }
    if (this.boundAdmission === null) {
      this.boundAdmission = this.admitBoundRuntime(signal);
    }
    await this.boundAdmission;
  }

  public async health(signal?: AbortSignal): Promise<ControllerHealth> {
    if (this.classicPolicy === "BOUND_EXISTING") {
      await this.initialize(signal);
      await this.assertBoundRuntimeCurrent(signal);
      return Object.freeze({ classic: "RUNNING", cdp: this.dependencies.cdp.state });
    }
    const runtime = await this.dependencies.runtime.inspect(signal);
    return Object.freeze({
      classic: runtime.isRunning ? "RUNNING" : "STOPPED",
      cdp: this.dependencies.cdp.state,
    });
  }

  public knownThreads(): readonly ThreadHandle[] {
    return this.dependencies.registry.knownThreads();
  }

  public executeTurn(
    request: ControllerTurnRequest,
    listener: (event: ResponseStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<TurnResult> {
    let projectLocator: ProjectLocator | null = null;
    const threadHandle = request.target.kind === "THREAD" ? request.target.threadHandle : null;
    let threadRegistrationState: "COMMITTED" | "PROVISIONAL" | null = null;
    if (threadHandle !== null) {
      threadRegistrationState = this.dependencies.registry.registrationState(threadHandle);
    } else if (request.target.kind === "PROJECT") {
      projectLocator = this.dependencies.projectRegistry.resolve(request.target.projectHandle);
    }

    return this.turnQueue.schedule(
      async () => {
        if (threadHandle !== null && threadRegistrationState === "PROVISIONAL") {
          await withTimeout(
            async (waitSignal) =>
              await this.dependencies.registry.waitForCommit(threadHandle, waitSignal),
            this.provisionalThreadWaitTimeoutMs,
            {
              message: "Timed out waiting for provisional Thread registration.",
              ...(signal ? { signal } : {}),
            },
          );
        }
        await this.awaitPendingCompletion(signal);
        await this.prepareRuntime(signal);

        let target: TurnTarget;
        if (request.target.kind === "FRESH") {
          await this.dependencies.router.routeFresh(signal);
          target = { kind: "FRESH" };
        } else if (request.target.kind === "THREAD") {
          await this.dependencies.router.routeToThread(request.target.threadHandle, signal);
          target = { kind: "THREAD", threadHandle: request.target.threadHandle };
        } else {
          await this.dependencies.router.routeToProject(projectLocator!, signal);
          target = { kind: "PROJECT", projectLocator: projectLocator! };
        }

        await this.assertBoundRuntimeCurrent(signal);
        const turnResult = await this.dependencies.executor.executeStreaming(
          target,
          request.prompt,
          listener,
          signal,
        );

        if (request.target.kind === "PROJECT" && turnResult.created) {
          this.installCompletionBarrier(turnResult);
        }

        return turnResult;
      },
      signal,
    );
  }

  public confirmTurnCompletion(result: TurnResult): void {
    this.dependencies.executor.confirmCompletedTurn?.(result);
    this.settleCompletionBarrier(result, true);
  }

  public rollbackTurnCompletion(result: TurnResult): void {
    this.dependencies.executor.rollbackCompletedTurn?.(result);
    this.settleCompletionBarrier(result, false);
  }

  public createProject(
    request: ControllerCreateProjectRequest,
    signal?: AbortSignal,
  ): Promise<ControllerCreateProjectResult> {
    return this.turnQueue.schedule(
      async () => {
        await this.awaitPendingCompletion(signal);
        await this.prepareRuntime(signal);
        await this.assertBoundRuntimeCurrent(signal);
        return await this.dependencies.projectCreator.create(request.name, signal);
      },
      signal,
    );
  }

  public recoverRuntime(signal?: AbortSignal): Promise<ControllerHealth> {
    return this.turnQueue.schedule(
      async () => {
        await this.awaitPendingCompletion(signal);
        throwIfAborted(signal);
        if (this.classicPolicy === "BOUND_EXISTING") {
          throw new RuntimeRecoveryForbiddenError();
        }
        const restart = this.dependencies.runtime.restart;
        if (restart === undefined) {
          throw new Error("Runtime recovery is unavailable.");
        }

        await this.dependencies.cdp.disconnect();
        await restart.call(this.dependencies.runtime);
        await this.dependencies.cdp.connect();
        this.dependencies.cdp.assertCurrentRuntime();
        return Object.freeze({
          classic: "RUNNING" as const,
          cdp: this.dependencies.cdp.state,
        });
      },
      signal,
    );
  }

  public async close(): Promise<void> {
    await this.dependencies.cdp.disconnect();
  }

  private async admitBoundRuntime(signal?: AbortSignal): Promise<void> {
    const requireExisting = this.dependencies.runtime.requireExisting;
    const bindExistingRuntime = this.dependencies.cdp.bindExistingRuntime;
    const assertBoundRuntimeCurrent = this.dependencies.cdp.assertBoundRuntimeCurrent;
    if (
      requireExisting === undefined ||
      bindExistingRuntime === undefined ||
      assertBoundRuntimeCurrent === undefined
    ) {
      throw new RuntimeProvenanceUnverifiedError();
    }
    const lease = await requireExisting.call(this.dependencies.runtime, signal);
    this.boundRuntimeLease = lease;
    await bindExistingRuntime.call(this.dependencies.cdp, lease, signal);
    await assertBoundRuntimeCurrent.call(this.dependencies.cdp, lease, signal);
  }

  private async prepareRuntime(signal?: AbortSignal): Promise<void> {
    if (this.classicPolicy === "MANAGED") {
      await this.dependencies.runtime.ensureStarted(signal);
      await this.dependencies.cdp.connect(signal);
      this.dependencies.cdp.assertCurrentRuntime();
      return;
    }
    await this.initialize(signal);
    await this.dependencies.cdp.connect(signal);
    await this.assertBoundRuntimeCurrent(signal);
  }

  private async assertBoundRuntimeCurrent(signal?: AbortSignal): Promise<void> {
    if (this.classicPolicy === "MANAGED") {
      return;
    }
    const lease = this.boundRuntimeLease;
    const assertBoundRuntimeCurrent = this.dependencies.cdp.assertBoundRuntimeCurrent;
    if (lease === null || assertBoundRuntimeCurrent === undefined) {
      throw new RequiredExistingRuntimeError();
    }
    await assertBoundRuntimeCurrent.call(this.dependencies.cdp, lease, signal);
  }

  private installCompletionBarrier(result: TurnResult): void {
    let settle!: (committed: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    this.pendingCompletionBarrier = { promise, settle };
    this.pendingCompletionResults.add(result);
  }

  private settleCompletionBarrier(result: TurnResult, committed: boolean): void {
    if (!this.pendingCompletionResults.has(result)) {
      return;
    }
    this.pendingCompletionResults.delete(result);
    const barrier = this.pendingCompletionBarrier;
    if (barrier === null) {
      return;
    }
    this.pendingCompletionBarrier = null;
    barrier.settle(committed);
  }

  private async awaitPendingCompletion(signal?: AbortSignal): Promise<void> {
    const barrier = this.pendingCompletionBarrier;
    if (barrier === null) {
      return;
    }
    const committed = await withTimeout(
      async (waitSignal) => {
        const onAbort = (): void => {};
        waitSignal.addEventListener("abort", onAbort, { once: true });
        try {
          return await barrier.promise;
        } finally {
          waitSignal.removeEventListener("abort", onAbort);
        }
      },
      this.provisionalThreadWaitTimeoutMs,
      {
        message: "Timed out waiting for Project public-completion settlement.",
        ...(signal ? { signal } : {}),
      },
    );
    if (!committed) {
      const { TurnStateUncertainError } = await import("../domain/errors.js");
      throw new TurnStateUncertainError(
        "A prior Project public-completion transaction was rolled back.",
      );
    }
  }
}

export function createThreadwireController(
  config: ControllerConfig,
  options: ThreadwireControllerOptions = {},
): ThreadwireController {
  const classicPolicy = config.classicPolicy ?? "MANAGED";
  const supervisor = new ClassicSupervisor(config);
  const registry = new ThreadRegistry();
  const scheduler = new OperationScheduler(supervisor);
  const cdp = classicPolicy === "BOUND_EXISTING"
    ? new BoundCdpSessionManager(
        config,
        supervisor,
        new BoundRuntimeProvenanceGuard(
          supervisor,
          new WindowsCdpEndpointProvenance(config),
        ),
      )
    : new CdpSessionManager(config, supervisor);
  const readiness = new ReadinessController(cdp);
  const router = new ConversationRouter(registry, scheduler, cdp, readiness);
  const executor = new TurnExecutor(registry, scheduler, readiness, cdp);
  const projectRegistry = new ProjectRegistry();
  const projectCreator = new ProjectCreator(projectRegistry, scheduler, cdp);

  return new ThreadwireController(
    { runtime: supervisor, cdp, registry, projectRegistry, router, executor, projectCreator },
    { ...options, classicPolicy },
  );
}
