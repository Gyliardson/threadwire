import CDP from "chrome-remote-interface";
import { CdpConnectionState } from "../domain/RuntimeState.js";
import { RuntimeGeneration } from "../domain/RuntimeGeneration.js";
import { CdpTargetDiscovery } from "./CdpTargetDiscovery.js";
import { ControllerConfig } from "../config/ControllerConfig.js";
import { CdpAttachFailedError, CdpDisconnectedError, RuntimeGenerationChangedError } from "../domain/errors.js";

export class CdpSessionManager {
  private currentState: CdpConnectionState = "DISCONNECTED";
  private client: any = null;
  private currentGeneration: RuntimeGeneration | null = null;
  private discovery: CdpTargetDiscovery;
  private config: ControllerConfig;

  constructor(config: ControllerConfig) {
    this.config = config;
    this.discovery = new CdpTargetDiscovery(config);
  }

  public get state(): CdpConnectionState {
    return this.currentState;
  }

  public async connect(generation: RuntimeGeneration): Promise<void> {
    if (this.currentState === "CONNECTED" && this.currentGeneration === generation) {
      return;
    }

    this.currentState = "DISCOVERING";
    const target = await this.discovery.findPrimaryTarget();

    this.currentState = "ATTACHING";
    try {
      this.client = await CDP({
        host: this.config.cdpHost,
        port: this.config.cdpPort,
        target: target.webSocketDebuggerUrl,
      });

      this.currentGeneration = generation;
      this.currentState = "CONNECTED";

      this.client.on("disconnect", () => {
        this.currentState = "DISCONNECTED";
        this.client = null;
      });

    } catch (err: any) {
      this.currentState = "FAILED";
      throw new CdpAttachFailedError(`Failed to attach CDP to target: ${err.message}`);
    }
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.currentState = "DISCONNECTED";
    this.currentGeneration = null;
  }

  public async command<T>(method: string, params?: unknown): Promise<T> {
    this.ensureConnected();
    try {
      return (await this.client.send(method, params)) as T;
    } catch (err: any) {
      throw new Error(`CDP command ${method} failed: ${err.message}`, { cause: err });
    }
  }

  public onEvent(method: string, listener: (payload: unknown) => void): () => void {
    this.ensureConnected();
    this.client.on(method, listener);
    return () => {
      if (this.client) {
        this.client.removeListener(method, listener);
      }
    };
  }

  public checkGeneration(generation: RuntimeGeneration) {
    if (this.currentGeneration !== generation) {
      throw new RuntimeGenerationChangedError();
    }
  }

  private ensureConnected() {
    if (this.currentState !== "CONNECTED" || !this.client) {
      throw new CdpDisconnectedError();
    }
  }
}
