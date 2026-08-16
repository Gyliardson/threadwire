export type CdpConnectionState =
  | "DISCONNECTED"
  | "DISCOVERING"
  | "ATTACHING"
  | "CONNECTED"
  | "RECONNECTING"
  | "FAILED";

export interface ClassicRuntimeSnapshot {
  isRunning: boolean;
  pid: number | null;
  generation: number;
}
