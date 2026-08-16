import { RuntimeGeneration } from "./RuntimeGeneration.js";

export type CdpConnectionState =
  | "DISCONNECTED"
  | "DISCOVERING"
  | "ATTACHING"
  | "CONNECTED"
  | "FAILED";

export type ClassicProcessRole = "MAIN" | "CHILD";

export interface ClassicProcessInfo {
  readonly pid: number;
  readonly parentPid: number;
  readonly commandLine: string | null;
  readonly creationTime: string;
  readonly role: ClassicProcessRole;
}

export interface ClassicRuntimeSnapshot {
  readonly isRunning: boolean;
  readonly pid: number | null;
  readonly generation: RuntimeGeneration;
  readonly mainProcess: ClassicProcessInfo | null;
  readonly processes: readonly ClassicProcessInfo[];
}
