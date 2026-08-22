import { CdpSessionManager } from "../cdp/CdpSessionManager.js";
import { ControllerConfig } from "../config/ControllerConfig.js";
import { CdpConnectionState } from "../domain/RuntimeState.js";
import { ThreadHandle } from "../domain/ThreadIdentity.js";
import { ReadinessController } from "../readiness/ReadinessController.js";
import { ResponseStreamEvent } from "../response/types.js";
import { ConversationRouter } from "../routing/ConversationRouter.js";
import { OperationScheduler } from "../routing/OperationScheduler.js";
import { ThreadRegistry } from "../routing/ThreadRegistry.js";
import { ClassicSupervisor } from "../runtime/ClassicSupervisor.js";
import { TurnExecutor } from "../turn/TurnExecutor.js";
import { TurnResponseEventListener, TurnResult, TurnTarget } from "../turn/types.js";
import {
  ControllerTurnQueue,
  DEFAULT_CONTROLLER_MAX_OUTSTANDING_TURNS,
} from "./ControllerTurnQueue.js";

export type ControllerTurnTarget =
  | Readonly<{ kind: "FRESH" }>
  | Readonly<{ kind: "THREAD"; threadHandle: ThreadHandle }>;

export interface ControllerTurnRequest {
  readonly target: ControllerTurnTarget;
  readonly prompt: string;
}

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
  knownThreads(): readonly ThreadHandle[];
}

export interface ConversationRouterControllerPort {
  routeFresh(signal?: AbortSignal): Promise<unknown>;
  routeToThread(handle: ThreadHandle, signal?: AbortSignal): Promise<unknown>;
}

export interface TurnExecutorControllerPort {
  executeStreaming(
    target: TurnTarget,
    text: string,
    listener: TurnResponseEventListener,
    signal?: AbortSignal,
  ): Promise<TurnResult>;
}

export interface ThreadwireControllerDependencies {
  readonly runtime: RuntimeControllerPort;
  readonly cdp: CdpControllerPort;
  readonly registry: ThreadRegistryControllerPort;
  readonly router: ConversationRouterControllerPort;
  readonly executor: TurnExecutorControllerPort;
}

export interface ThreadwireControllerOptions {
  readonly maxOutstandingTurns?: number;
}

export class ThreadwireController {
  private readonly turnQueue: ControllerTurnQueue;

  public constructor(
    private readonly dependencies: ThreadwireControllerDependencies,
    options: ThreadwireControllerOptions = {},
  ) {
    this.turnQueue = new ControllerTurnQueue(
      options.maxOutstandingTurns ?? DEFAULT_CONTROLLER_MAX_OUTSTANDING_TURNS,
    );
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
    if (request.target.kind === "THREAD") {
      this.dependencies.registry.resolve(request.target.threadHandle);
    }

    return this.turnQueue.schedule(
      async () => {
        await this.dependencies.runtime.ensureStarted(signal);
        await this.dependencies.cdp.connect(signal);
        this.dependencies.cdp.assertCurrentRuntime();

        let target: TurnTarget;
        if (request.target.kind === "FRESH") {
          await this.dependencies.router.routeFresh(signal);
          target = { kind: "FRESH" };
        } else {
          await this.dependencies.router.routeToThread(request.target.threadHandle, signal);
          target = { kind: "THREAD", threadHandle: request.target.threadHandle };
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

  return new ThreadwireController(
    { runtime: supervisor, cdp, registry, router, executor },
    options,
  );
}
