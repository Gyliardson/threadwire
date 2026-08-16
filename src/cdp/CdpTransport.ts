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
  navigate(url: string): Promise<void>;
}

export interface CdpTransport {
  connect(options: CdpTransportConnectOptions): Promise<CdpTransportSession>;
}
