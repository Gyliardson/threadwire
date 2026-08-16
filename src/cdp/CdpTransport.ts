import { ConversationLocator } from "../domain/ThreadIdentity.js";
import { ExistingReadinessSnapshot } from "../readiness/types.js";
import { CdpTargetInfo } from "./types.js";

export interface CdpTransportConnectOptions {
  readonly host: string;
  readonly port: number;
  readonly target: CdpTargetInfo;
  readonly signal?: AbortSignal;
}

export interface CdpTransportSession {
  close(): Promise<void>;
  onDisconnect(listener: () => void): () => void;
  initializeReadinessObservation(): Promise<void>;
  navigate(url: string): Promise<void>;
  getReadinessSnapshot(expectedLocator: ConversationLocator): Promise<ExistingReadinessSnapshot>;
  focusBackendNode(backendDOMNodeId: number): Promise<void>;
}

export interface CdpTransport {
  connect(options: CdpTransportConnectOptions): Promise<CdpTransportSession>;
}
