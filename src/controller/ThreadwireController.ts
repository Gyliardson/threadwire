import { CdpSessionManager } from "../cdp/CdpSessionManager.js";
import { ControllerConfig } from "../config/ControllerConfig.js";
import { CdpConnectionState } from "../domain/RuntimeState.js";
import { ThreadHandle } from "../domain/ThreadIdentity.js";
import { ProjectHandle, ProjectLocator } from "../domain/ProjectIdentity.js";
import { ProjectCreator } from "../project/ProjectCreator.js";
import { ProjectRegistry } from "../project/ProjectRegistry.js";
import { ReadinessController } from "../readiness/ReadinessController.js";
import { ResponseStreamEvent } from "../response/types.js";
import { ConversationRouter } from "../routing/ConversationRouter.js";
import { OperationScheduler } from "../routing/OperationScheduler.js";
import { ThreadRegistry } from "../routing/ThreadRegistry.js";
import { ClassicSupervisor } from "../runtime/ClassicSupervisor.js";
import { TurnExecutor } from "../turn/TurnExecutor.js";
import { TurnResponseEventListener, TurnResult, TurnTarget } from "../turn/types.js";
import { withTimeout } from "../utils/timeout.js";
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
}

export interface CdpControllerPort {
  readonly state: CdpConnectionState;
  connect(signal?: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;
  assertCurrentRuntime(): void;
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
}

export const DEFAULT_PROVISIONAL_THREAD_WAIT_TIMEOUT_MS = 15_000;

export class ThreadwireController {
  private readonly turnQueue: ControllerTurnQueue;
  private readonly provisionalThreadWaitTimeoutMs: number;

  public constructor(
    private readonly dependencies: ThreadwireControllerDependencies,
    options: ThreadwireControllerOptions = {},
  ) {
    this.turnQueue = new ControllerTurnQueue(
      options.maxOutstandingTurns ?? DEFAULT_CONTROLLER_MAX_OUTSTANDING_TURNS,
    );
    this.provisionalThreadWaitTimeoutMs =
      options.provisionalThreadWaitTimeoutMs ?? DEFAULT_PROVISIONAL_THREAD_WAIT_TIMEOUT_MS;
    if (
      !Number.isFinite(this.provisionalThreadWaitTimeoutMs) ||
      this.provisionalThreadWaitTimeoutMs <= 0
    ) {
      throw new RangeError("provisionalThreadWaitTimeoutMs must be a positive finite number.");
    }
  }

  public async health(signal?: AbortSignal): Promise<ControllerHealth> {
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
        await this.dependencies.runtime.ensureStarted(signal);
        await this.dependencies.cdp.connect(signal);
        this.dependencies.cdp.assertCurrentRuntime();

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

        return await this.dependencies.executor.executeStreaming(
          target,
          request.prompt,
          listener,
          signal,
        );
      },
      signal,
    );
  }

  public confirmTurnCompletion(result: TurnResult): void {
    this.dependencies.executor.confirmCompletedTurn?.(result);
  }

  public rollbackTurnCompletion(result: TurnResult): void {
    this.dependencies.executor.rollbackCompletedTurn?.(result);
  }

  public createProject(
    request: ControllerCreateProjectRequest,
    signal?: AbortSignal,
  ): Promise<ControllerCreateProjectResult> {
    return this.turnQueue.schedule(
      async () => {
        await this.dependencies.runtime.ensureStarted(signal);
        await this.dependencies.cdp.connect(signal);
        this.dependencies.cdp.assertCurrentRuntime();
        return await this.dependencies.projectCreator.create(request.name, signal);
      },
      signal,
    );
  }

  public async close(): Promise<void> {
    await this.dependencies.cdp.disconnect();
  }
}

export function createThreadwireController(
  config: ControllerConfig,
  options: ThreadwireControllerOptions = {},
): ThreadwireController {
  const supervisor = new ClassicSupervisor(config);
  const registry = new ThreadRegistry();
  const scheduler = new OperationScheduler(supervisor);
  const cdp = new CdpSessionManager(config, supervisor);
  const readiness = new ReadinessController(cdp);
  const router = new ConversationRouter(registry, scheduler, cdp, readiness);
  const executor = new TurnExecutor(registry, scheduler, readiness, cdp);
  const projectRegistry = new ProjectRegistry();
  const projectCreator = new ProjectCreator(projectRegistry, scheduler, cdp);

  return new ThreadwireController(
    { runtime: supervisor, cdp, registry, projectRegistry, router, executor, projectCreator },
    options,
  );
}
