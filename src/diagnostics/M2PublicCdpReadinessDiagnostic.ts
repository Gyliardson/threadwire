import { BoundCdpSessionManager } from "../cdp/BoundCdpSessionManager.js";
import { CdpSessionManager } from "../cdp/CdpSessionManager.js";
import { CdpTransportSession } from "../cdp/CdpTransport.js";
import { ControllerConfig } from "../config/ControllerConfig.js";
import {
  ThreadwireController,
  ThreadwireControllerOptions,
  createThreadwireController,
} from "../controller/ThreadwireController.js";
import { RuntimeLease, sameRuntimeLease } from "../domain/RuntimeGeneration.js";
import {
  CdpDisconnectedError,
  CdpReadinessFailedError,
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

export type M2PrepareCdpMode = "REUSED_CONNECTED" | "RECONNECT_ATTEMPTED";

export type M2CdpDiagnosticStage =
  | "RECONNECT_READINESS_INIT"
  | "FRESH_READINESS_SNAPSHOT"
  | "FRESH_READINESS_FOCUS"
  | "BOUND_RUNTIME_CURRENTNESS";

export type M2CdpDiagnosticErrorClass =
  | "READINESS_INITIALIZATION_FAILED"
  | "READINESS_OBSERVATION_FAILED"
  | "FOCUS_FAILED"
  | "SESSION_UNAVAILABLE"
  | "PROVENANCE_UNVERIFIED";

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

interface ReplacementPreparationBoundary {
  initializeReadinessObservation(
    session: CdpTransportSession,
    signal?: AbortSignal,
  ): Promise<void>;
}

interface FreshFocusArm {
  readonly lease: RuntimeLease;
  readonly backendDOMNodeId: number;
}

function classifyFailure(
  stage: M2CdpDiagnosticStage,
  error: unknown,
): ClassifiedFailure | null {
  if (error instanceof RuntimeProvenanceUnverifiedError) {
    return {
      stage: "BOUND_RUNTIME_CURRENTNESS",
      errorClass: "PROVENANCE_UNVERIFIED",
    };
  }

  if (error instanceof CdpDisconnectedError) {
    if (stage === "FRESH_READINESS_SNAPSHOT" || stage === "FRESH_READINESS_FOCUS") {
      return { stage, errorClass: "SESSION_UNAVAILABLE" };
    }
    return null;
  }

  if (!(error instanceof CdpReadinessFailedError)) {
    return null;
  }

  if (stage === "RECONNECT_READINESS_INIT") {
    return { stage, errorClass: "READINESS_INITIALIZATION_FAILED" };
  }
  if (stage === "FRESH_READINESS_SNAPSHOT") {
    return { stage, errorClass: "READINESS_OBSERVATION_FAILED" };
  }
  if (stage === "FRESH_READINESS_FOCUS") {
    return { stage, errorClass: "FOCUS_FAILED" };
  }
  return null;
}

function installReplacementPreparationTracker(cdp: CdpSessionManager): () => number {
  let sequence = 0;
  const boundary = cdp as unknown as ReplacementPreparationBoundary;
  const initializeReadinessObservation = boundary.initializeReadinessObservation.bind(cdp);

  boundary.initializeReadinessObservation = async (
    session: CdpTransportSession,
    signal?: AbortSignal,
  ): Promise<void> => {
    sequence += 1;
    await initializeReadinessObservation(session, signal);
  };

  return () => sequence;
}

export class M2PublicCdpReadinessDiagnostic {
  private prepareCdpMode: M2PrepareCdpMode | null = null;

  public constructor(private readonly sink: M2PublicCdpReadinessDiagnosticSink) {}

  public observePrepareMode(mode: M2PrepareCdpMode): void {
    this.prepareCdpMode = mode;
  }

  public recordFailure(stage: M2CdpDiagnosticStage, error: unknown): void {
    const prepareCdpMode = this.prepareCdpMode;
    if (prepareCdpMode === null) {
      return;
    }

    const classified = classifyFailure(stage, error);
    if (classified === null) {
      return;
    }

    const event = Object.freeze({
      schema: M2_PUBLIC_CDP_DIAGNOSTIC_SCHEMA,
      operation: "PUBLIC_CDP_READINESS_RCA" as const,
      prepareCdpMode,
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

export function wrapM2PublicCdpReadinessDiagnostics<T extends CdpSessionManager>(
  cdp: T,
  diagnostic: M2PublicCdpReadinessDiagnostic,
): T {
  const replacementPreparationSequence = installReplacementPreparationTracker(cdp);
  let freshFocusArm: FreshFocusArm | null = null;

  return new Proxy(cdp, {
    get(target, property) {
      if (property === "connect") {
        return async (signal?: AbortSignal): Promise<void> => {
          const sequenceBefore = replacementPreparationSequence();
          try {
            await target.connect(signal);
            diagnostic.observePrepareMode(
              replacementPreparationSequence() === sequenceBefore
                ? "REUSED_CONNECTED"
                : "RECONNECT_ATTEMPTED",
            );
          } catch (error) {
            if (
              replacementPreparationSequence() !== sequenceBefore &&
              error instanceof CdpReadinessFailedError
            ) {
              diagnostic.observePrepareMode("RECONNECT_ATTEMPTED");
              diagnostic.recordFailure("RECONNECT_READINESS_INIT", error);
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
          freshFocusArm = null;
          try {
            const snapshot = await target.getReadinessSnapshot(expectedRoute, lease, signal);
            const composer = snapshot.eligibleEditables.length === 1
              ? snapshot.eligibleEditables[0]
              : undefined;
            if (isFresh && composer !== undefined) {
              freshFocusArm = Object.freeze({
                lease,
                backendDOMNodeId: composer.backendDOMNodeId,
              });
            }
            return snapshot;
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
          const arm = freshFocusArm;
          freshFocusArm = null;
          const isFreshFocus =
            arm !== null &&
            arm.backendDOMNodeId === backendDOMNodeId &&
            sameRuntimeLease(arm.lease, lease);
          try {
            await target.focusBackendNode(backendDOMNodeId, lease, signal);
          } catch (error) {
            if (isFreshFocus) {
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

export interface M2PublicCdpDiagnosticControllerFactories {
  readonly createNormal: (
    config: ControllerConfig,
    options?: ThreadwireControllerOptions,
  ) => ThreadwireController;
  readonly createDiagnostic: (
    config: ControllerConfig,
    diagnostic: M2PublicCdpReadinessDiagnostic,
    options?: ThreadwireControllerOptions,
  ) => ThreadwireController;
}

const DEFAULT_CONTROLLER_FACTORIES: M2PublicCdpDiagnosticControllerFactories = Object.freeze({
  createNormal: createThreadwireController,
  createDiagnostic: createM2PublicCdpDiagnosticThreadwireController,
});

export function createThreadwireControllerWithM2PublicCdpDiagnostic(
  config: ControllerConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  factories: M2PublicCdpDiagnosticControllerFactories = DEFAULT_CONTROLLER_FACTORIES,
): ThreadwireController {
  const diagnostic = createM2PublicCdpReadinessDiagnosticFromEnvironment(environment);
  if (diagnostic === null) {
    return factories.createNormal(config);
  }
  return factories.createDiagnostic(config, diagnostic);
}
