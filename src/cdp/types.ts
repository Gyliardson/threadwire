export interface CdpTargetInfo {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly description: string;
  readonly webSocketDebuggerUrl: string | null;
  readonly url: string;
}

export type CdpTargetList = readonly CdpTargetInfo[];
