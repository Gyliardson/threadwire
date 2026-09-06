import { BoundCdpSessionManager } from "../cdp/BoundCdpSessionManager.js";
import { CdpSessionManager } from "../cdp/CdpSessionManager.js";
import { ControllerConfig } from "../config/ControllerConfig.js";
import {
  ThreadwireController,
  ThreadwireControllerOptions,
} from "../controller/ThreadwireController.js";
import {
  CdpDisconnectedError,
  CdpReadinessFailedError,
  OperationAbortedError,
  RuntimeGenerationChangedError,
  RuntimeProvenanceUnverifiedError,
} from "../domain/errors.js";
import { ProjectCreator } from "../project/ProjectCreator.js";
import { ProjectRegistry } from "../project/ProjectRegistry.js";
import { ReadinessController } from "../readiness/ReadinessController.js";
import { ExistingReadinessSnapshot, RouteExpectation } from "../readiness/types.js";
import { ConversationRouter } from "../routing/ConversationRouter.js";
import { OperationScheduler } from "../routing/OperationScheduler.js";
import { ThreadRegistry } from "../routing/ThreadRegistry.js";
import { BoundRuntimeProvenanceGuard } from "../runtime/BoundRuntimeProvenanceGuard.js";
import { WindowsCdpEndpointProvenance } from "../runtime/CdpEndpointProvenance.js";
import { ClassicSupervisor } from "../runtime/ClassicSupervisor.js";
import { TurnExecutor } from "../turn/TurnExecutor.js";

export const M2_PUBLIC_CDP_DIAGNOSTIC_ENV = "THREADWIRE_M2_PUBLIC_CDP_DIAGNOSTIC";
export const M2_PUBLIC_CDP_DIAGNOSTIC_PREFIX = "THREADWIRE_M2_PUBLIC_CDP_DIAGNOSTIC_V1";
export const M2_PUBLIC_CDP_DIAGNOSTIC_SCHEMA = "M2_PUBLIC_CDP_DIAGNOSTIC_V1" as const;

export type M2PrepareCdpMode =
  | "NOT_OBSERVED"
  | "EXISTING_SESSION"
  | "CONNECT_OR_RECONNECT";

export type M2CdpDiagnosticStage =
  | "CDP_PREPARE_CONNECT"
  | "CDP_PREPARE_READINESS_INIT"
  | "FRESH_READINESS_SNAPSHOT"
  | "FRESH_READINESS_FOCUS"
  | "BOUND_RUNTIME_CURRENTNESS";

export type M2CdpDiagnosticErrorClass =
  | "SESSION_UNAVAILABLE"
  | "READINESS_INITIALIZATION_FAILED"
  | "READINESS_OBSERVATION_FAILED"
  | "FOCUS_FAILED"
  | "PROVENANCE_UNVERIFIED"
  | "RUNTIME_REPLACED"
  | "ABORTED"
  | "UNEXPECTED_INTERNAL";

export interface M2PublicCdpReadinessDiagnosticEvent {
  readonly schema: typeof M2_PUBLIC_CDP_DIAGNOSTIC_SCHEMA;
  readonly operation: "PUBLIC_CDP_READINESS_RCA";
  readonly prepareCdpMode: M2PrepareCdpMode;
  readonly stage: M2CdpDiagnosticStage;
  readonly errorClass: M2CdpDiagnosticErrorClass;
  readonly outcome: "FAILURE";
}

export type M2PublicCdpReadinessDiagnosticSink = (
  event: M2PublicCdpReadinessDiagnosticEvent,
) => void;

interface ClassifiedFailure {
  readonly stage: M2CdpDiagnosticStage;
  readonly errorClass: M2CdpDiagnosticErrorClass;
}

function classifyFailure(
  stage: M2CdpDiagnosticStage,
  error: unknown,
): ClassifiedFailure {
  if (error instanceof RuntimeProvenanceUnverifiedError) {
    return {
      stage: "BOUND_RUNTIME_CURRENTNESS",
      errorClass: "PROVENANCE_UNVERIFIED",
    };
  }
  if (error instanceof RuntimeGenerationChangedError) {
    return {
      stage: "BOUND_RUNTIME_CURRENTNESS",
      errorClass: "RUNTIME_REPLACED",
    };
  }
  if (error instanceof OperationAbortedError) {
    return { stage, errorClass: "ABORTED" };
  }
  if (error instanceof CdpDisconnectedError) {
    return { stage, errorClass: "SESSION_UNAVAILABLE" };
  }
  if (error instanceof CdpReadinessFailedError) {
    if (stage === "CDP_PREPARE_CONNECT" || stage === "CDP_PREPARE_READINESS_INIT") {
      return {
        stage: "CDP_PREPARE_READINESS_INIT",
        errorClass: "READINESS_INITIALIZATION_FAILED",
      };
    }
    if (stage === "FRESH_READINESS_FOCUS") {
      return { stage, errorClass: "FOCUS_FAILED" };
    }
    return { stage, errorClass: "READINESS_OBSERVATION_FAILED" };
  }
  return { stage, errorClass: "UNEXPECTED_INTERNAL" };
}

function isRelevantPrepareFailure(error: unknown): boolean {
  return (
    error instanceof CdpReadinessFailedError ||
    error instanceof CdpDisconnectedError ||
    error instanceof RuntimeProvenanceUnverifiedError ||
    error instanceof RuntimeGenerationChangedError ||
    error instanceof OperationAbortedError
  );
}

export class M2PublicCdpReadinessDiagnostic {
  private prepareCdpMode: M2PrepareCdpMode = "NOT_OBSERVED";

  public constructor(private readonly sink: M2PublicCdpReadinessDiagnosticSink) {}

  public observePrepareMode(mode: M2PrepareCdpMode): void {
    this.prepareCdpMode = mode;
  }

  public recordFailure(stage: M2CdpDiagnosticStage, error: unknown): void {
    const classified = classifyFailure(stage, error);
    const event = Object.freeze({
      schema: M2_PUBLIC_CDP_DIAGNOSTIC_SCHEMA,
      operation: "PUBLIC_CDP_READINESS_RCA" as const,
      prepareCdpMode: this.prepareCdpMode,
      stage: classified.stage,
      errorClass: classified.errorClass,
      outcome: "FAILURE" as const,
    });

    try {
      this.sink(event);
    } catch {
      // Diagnostic delivery is strictly best-effort and may not affect product behavior.
    }
  }
}

export function createM2PublicCdpReadinessDiagnosticFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  writeLine: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): M2PublicCdpReadinessDiagnostic | null {
  if (environment[M2_PUBLIC_CDP_DIAGNOSTIC_ENV] !== "1") {
    return null;
  }

  return new M2PublicCdpReadinessDiagnostic((event) => {
    writeLine(`${M2_PUBLIC_CDP_DIAGNOSTIC_PREFIX} ${JSON.stringify(event)}\n`);
  });
}

function existingSessionBranch(cdp: CdpSessionManager): boolean {
  try {
    cdp.assertCurrentRuntime();
    return true;
  } catch {
    return false;
  }
}

export function wrapM2PublicCdpReadinessDiagnostics<T extends CdpSessionManager>(
  cdp: T,
  diagnostic: M2PublicCdpReadinessDiagnostic,
): T {
  let freshReadinessOperation = false;

  return new Proxy(cdp, {
    get(target, property) {
      if (property === "connect") {
        return async (signal?: AbortSignal): Promise<void> => {
          diagnostic.observePrepareMode(
            existingSessionBranch(target) ? "EXISTING_SESSION" : "CONNECT_OR_RECONNECT",
          );
          try {
            await target.connect(signal);
          } catch (error) {
            if (isRelevantPrepareFailure(error)) {
              diagnostic.recordFailure("CDP_PREPARE_CONNECT", error);
            }
            throw error;
          }
        };
      }

      if (property === "getReadinessSnapshot") {
        return async (
          expectedRoute: RouteExpectation,
          lease: Parameters<CdpSessionManager["getReadinessSnapshot"]>[1],
          signal?: AbortSignal,
        ): Promise<ExistingReadinessSnapshot> => {
          const isFresh = expectedRoute.kind === "FRESH_ROOT";
          freshReadinessOperation = isFresh;
          try {
            return await target.getReadinessSnapshot(expectedRoute, lease, signal);
          } catch (error) {
            if (isFresh) {
              diagnostic.recordFailure("FRESH_READINESS_SNAPSHOT", error);
            }
            throw error;
          }
        };
      }

      if (property === "focusBackendNode") {
        return async (
          backendDOMNodeId: number,
          lease: Parameters<CdpSessionManager["focusBackendNode"]>[1],
          signal?: AbortSignal,
        ): Promise<void> => {
          try {
            await target.focusBackendNode(backendDOMNodeId, lease, signal);
          } catch (error) {
            if (freshReadinessOperation) {
              diagnostic.recordFailure("FRESH_READINESS_FOCUS", error);
            }
            throw error;
          }
        };
      }

      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}

export function createM2PublicCdpDiagnosticThreadwireController(
  config: ControllerConfig,
  diagnostic: M2PublicCdpReadinessDiagnostic,
  options: ThreadwireControllerOptions = {},
): ThreadwireController {
  const classicPolicy = config.classicPolicy ?? "MANAGED";
  const supervisor = new ClassicSupervisor(config);
  const registry = new ThreadRegistry();
  const scheduler = new OperationScheduler(supervisor);
  const rawCdp = classicPolicy === "BOUND_EXISTING"
    ? new BoundCdpSessionManager(
        config,
        supervisor,
        new BoundRuntimeProvenanceGuard(
          supervisor,
          new WindowsCdpEndpointProvenance(config),
        ),
      )
    : new CdpSessionManager(config, supervisor);
  const cdp = wrapM2PublicCdpReadinessDiagnostics(rawCdp, diagnostic);
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
