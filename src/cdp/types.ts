export interface CdpTargetInfo {
  id: string;
  title: string;
  type: string;
  description: string;
  webSocketDebuggerUrl: string;
  url: string;
}

export type CdpTargetList = CdpTargetInfo[];
