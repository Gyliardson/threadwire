import { ControllerConfig } from "../config/ControllerConfig.js";
import { ConversationLocator } from "../domain/ThreadIdentity.js";
import {
  RuntimeGeneration,
  RuntimeLease,
  RuntimeLeaseSource,
  sameRuntimeLease,
} from "../domain/RuntimeGeneration.js";
import { CdpConnectionState } from "../domain/RuntimeState.js";
import {
  CdpAttachFailedError,
  CdpDisconnectedError,
  CdpNavigationFailedError,
  CdpReadinessFailedError,
  OperationAbortedError,
  RuntimeGenerationChangedError,
  ThreadwireError,
} from "../domain/errors.js";
import { ExistingReadinessSnapshot } from "../readiness/types.js";
import { throwIfAborted, withTimeout } from "../utils/timeout.js";
import { ChromeRemoteInterfaceTransport } from "./ChromeRemoteInterfaceTransport.js";
import { CdpTargetDiscovery, FindPrimaryTargetOptions } from "./CdpTargetDiscovery.js";
import { CdpTransport, CdpTransportSession } from "./CdpTransport.js";

const DEFAULT_ATTACH_TIMEOUT_MS = 5000;

export interface CdpTargetDiscoveryLike {
  findPrimaryTarget(options?: FindPrimaryTargetOptions): ReturnType<CdpTargetDiscovery["findPrimaryTarget"]>;
}

export interface CdpSessionManagerOptions {
  readonly discovery?: CdpTargetDiscoveryLike;
  readonly transport?: CdpTransport;
  readonly attachTimeoutMs?: number;
}

export class CdpSessionManager {
  private currentState: CdpConnectionState = "DISCONNECTED";
  private session: CdpTransportSession | null = null;
  private boundLease: RuntimeLease | null = null;
  private selectedTargetId: string | null = null;
  private unsubscribeDisconnect: (() => void) | null = null;
  private readonly discovery: CdpTargetDiscoveryLike;
  private readonly transport: CdpTransport;
  private readonly attachTimeoutMs: number;

  public constructor(
    private readonly config: ControllerConfig,
    private readonly runtime: RuntimeLeaseSource,
    options: CdpSessionManagerOptions = {},
  ) {
    this.discovery = options.discovery ?? new CdpTargetDiscovery(config);
    this.transport = options.transport ?? new ChromeRemoteInterfaceTransport();
    this.attachTimeoutMs = options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
  }

  public get state(): CdpConnectionState {
    return this.currentState;
  }

  public get boundGeneration(): RuntimeGeneration | null {
    return this.boundLease?.generation ?? null;
  }

  public get targetId(): string | null {
    return this.selectedTargetId;
  }

  public async connect(signal?: AbortSignal): Promise<void> {
    const lease = this.runtime.getCurrentRuntimeLease();
    if (this.currentState === "CONNECTED" && this.boundLease && sameRuntimeLease(this.boundLease, lease)) {
      return;
    }

    try {
      await this.disposeSession();
    } catch (error) {
      this.currentState = "FAILED";
      throw new CdpDisconnectedError("Failed to replace the previous CDP session cleanly.", {
        cause: error,
      });
    }
    this.currentState = "DISCOVERING";

    try {
      const target = await this.discovery.findPrimaryTarget(signal ? { signal } : {});
      this.runtime.assertRuntimeLeaseCurrent(lease);
      this.currentState = "ATTACHING";

      const session = await withTimeout(
        async (attachSignal) =>
          await this.transport.connect({
            host: this.config.cdpHost,
            port: this.config.cdpPort,
            target,
            signal: attachSignal,
          }),
        this.attachTimeoutMs,
        signal
          ? { signal, message: "Timed out attaching to the selected CDP target." }
          : { message: "Timed out attaching to the selected CDP target." },
      );

      try {
        this.runtime.assertRuntimeLeaseCurrent(lease);
        await withTimeout(
          async (readinessSignal) => {
            throwIfAborted(readinessSignal);
            await session.initializeReadinessObservation();
            throwIfAborted(readinessSignal);
          },
          this.attachTimeoutMs,
          signal
            ? { signal, message: "Timed out initializing CDP readiness observation." }
            : { message: "Timed out initializing CDP readiness observation." },
        );
        this.runtime.assertRuntimeLeaseCurrent(lease);
      } catch (error) {
        await session.close().catch(() => undefined);
        if (error instanceof RuntimeGenerationChangedError || error instanceof OperationAbortedError) {
          throw error;
        }
        throw new CdpReadinessFailedError(undefined, { cause: error });
      }

      this.session = session;
      this.boundLease = lease;
      this.selectedTargetId = target.id;
      this.currentState = "CONNECTED";
      this.unsubscribeDisconnect = session.onDisconnect(() => {
        if (this.session !== session) {
          return;
        }
        this.unsubscribeDisconnect = null;
        this.session = null;
        this.boundLease = null;
        this.selectedTargetId = null;
        this.currentState = "DISCONNECTED";
      });
    } catch (error) {
      this.currentState = "FAILED";
      if (error instanceof RuntimeGenerationChangedError || error instanceof OperationAbortedError) {
        throw error;
      }
      if (error instanceof ThreadwireError && error.code.startsWith("CDP_") && error.code !== "CDP_ATTACH_FAILED") {
        throw error;
      }
      if (error instanceof CdpAttachFailedError) {
        throw error;
      }
      throw new CdpAttachFailedError(undefined, { cause: error });
    }
  }

  public async disconnect(): Promise<void> {
    try {
      await this.disposeSession();
    } catch (error) {
      this.currentState = "DISCONNECTED";
      throw new CdpDisconnectedError("Failed to close the CDP session cleanly.", { cause: error });
    }
    this.currentState = "DISCONNECTED";
  }

  public assertCurrentRuntime(): void {
    if (this.currentState !== "CONNECTED" || this.boundLease === null || this.session === null) {
      throw new CdpDisconnectedError();
    }
    this.runtime.assertRuntimeLeaseCurrent(this.boundLease);
  }

  public async navigate(url: string, signal?: AbortSignal): Promise<void> {
    this.assertCurrentRuntime();
    throwIfAborted(signal);
    const session = this.session!;
    try {
      await session.navigate(url);
    } catch (error) {
      throw new CdpNavigationFailedError(undefined, { cause: error });
    }
  }

  public async getReadinessSnapshot(
    expectedLocator: ConversationLocator,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<ExistingReadinessSnapshot> {
    throwIfAborted(signal);
    const session = this.requireSessionForLease(lease);
    try {
      return await this.runReadinessSessionOperation(
        session,
        lease,
        () => session.getReadinessSnapshot(expectedLocator),
        signal,
      );
    } catch (error) {
      this.rethrowReadinessLifecycleError(error, session, lease, signal);
    }
  }

  public async focusBackendNode(
    backendDOMNodeId: number,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isSafeInteger(backendDOMNodeId) || backendDOMNodeId <= 0) {
      throw new CdpReadinessFailedError();
    }

    throwIfAborted(signal);
    const session = this.requireSessionForLease(lease);
    try {
      await this.runReadinessSessionOperation(
        session,
        lease,
        () => session.focusBackendNode(backendDOMNodeId),
        signal,
      );
    } catch (error) {
      this.rethrowReadinessLifecycleError(error, session, lease, signal);
    }
  }

  private async runReadinessSessionOperation<T>(
    session: CdpTransportSession,
    lease: RuntimeLease,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.assertSessionForLeaseCurrent(session, lease);
    throwIfAborted(signal);

    const operationPromise = operation();
    if (!signal) {
      const result = await operationPromise;
      this.assertSessionForLeaseCurrent(session, lease);
      return result;
    }

    let onAbort: (() => void) | null = null;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        this.invalidateSessionAfterInFlightAbort(session);
        try {
          throwIfAborted(signal);
          reject(new OperationAbortedError());
        } catch (error) {
          reject(error);
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      const result = await Promise.race([operationPromise, abortPromise]);
      throwIfAborted(signal);
      this.assertSessionForLeaseCurrent(session, lease);
      return result;
    } finally {
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  private invalidateSessionAfterInFlightAbort(session: CdpTransportSession): void {
    if (this.session !== session) {
      return;
    }

    this.unsubscribeDisconnect?.();
    this.unsubscribeDisconnect = null;
    this.session = null;
    this.boundLease = null;
    this.selectedTargetId = null;
    this.currentState = "DISCONNECTED";
    void session.close().catch(() => undefined);
  }

  private requireSessionForLease(lease: RuntimeLease): CdpTransportSession {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    if (this.currentState !== "CONNECTED" || this.boundLease === null || this.session === null) {
      throw new CdpDisconnectedError();
    }
    if (!sameRuntimeLease(this.boundLease, lease)) {
      throw new RuntimeGenerationChangedError();
    }
    return this.session;
  }

  private assertSessionForLeaseCurrent(session: CdpTransportSession, lease: RuntimeLease): void {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    if (
      this.currentState !== "CONNECTED" ||
      this.session !== session ||
      this.boundLease === null
    ) {
      throw new CdpDisconnectedError();
    }
    if (!sameRuntimeLease(this.boundLease, lease)) {
      throw new RuntimeGenerationChangedError();
    }
  }

  private rethrowReadinessLifecycleError(
    error: unknown,
    session: CdpTransportSession,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): never {
    throwIfAborted(signal);

    try {
      this.assertSessionForLeaseCurrent(session, lease);
    } catch (lifecycleError) {
      throw lifecycleError;
    }

    if (
      error instanceof RuntimeGenerationChangedError ||
      error instanceof OperationAbortedError ||
      error instanceof CdpDisconnectedError ||
      error instanceof CdpReadinessFailedError
    ) {
      throw error;
    }

    throw new CdpReadinessFailedError(undefined, { cause: error });
  }

  private async disposeSession(): Promise<void> {
    this.unsubscribeDisconnect?.();
    this.unsubscribeDisconnect = null;
    const session = this.session;
    this.session = null;
    this.boundLease = null;
    this.selectedTargetId = null;
    if (session) {
      await session.close();
    }
  }
}
