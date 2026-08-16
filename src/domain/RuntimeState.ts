import { RuntimeGeneration } from "./RuntimeGeneration.js";

export type CdpConnectionState =
  | "DISCONNECTED"
  | "DISCOVERING"
  | "ATTACHING"
  | "CONNECTED"
  | "FAILED";

export type ClassicProcessRole = "MAIN" | "CHILD";

export interface ClassicProcessObservation {
  readonly pid: number;
  readonly parentPid: number;
  readonly creationTime: string;
  readonly role: ClassicProcessRole;
}

export interface ClassicRuntimeSnapshot {
  readonly isRunning: boolean;
  readonly pid: number | null;
  readonly generation: RuntimeGeneration;
  readonly mainProcess: ClassicProcessObservation | null;
  readonly processes: readonly ClassicProcessObservation[];
}
