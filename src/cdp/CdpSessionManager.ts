import { ControllerConfig } from "../config/ControllerConfig.js";
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
  OperationAbortedError,
  RuntimeGenerationChangedError,
  ThreadwireError,
} from "../domain/errors.js";
import { withTimeout } from "../utils/timeout.js";
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
      throw new CdpDisconnectedError("Failed to replace the previous CDP session cleanly.", { cause: error });
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
        signal ? { signal, message: "Timed out attaching to the selected CDP target." } : { message: "Timed out attaching to the selected CDP target." },
      );

      try {
        this.runtime.assertRuntimeLeaseCurrent(lease);
      } catch (error) {
        await session.close().catch(() => undefined);
        throw error;
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
