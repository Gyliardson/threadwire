import { ControllerConfig } from "../config/ControllerConfig.js";
import { RuntimeLease, sameRuntimeIdentity } from "../domain/RuntimeGeneration.js";
import {
  OperationAbortedError,
  RuntimeProvenanceUnverifiedError,
} from "../domain/errors.js";
import { CommandRunner, NodeCommandRunner } from "./CommandRunner.js";

const MAX_ANCESTRY_DEPTH = 64;

const LISTENER_PROVENANCE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$hostAddress = [string]$env:THREADWIRE_CDP_HOST
$port = [int]$env:THREADWIRE_CDP_PORT
$expectedPid = [int]$env:THREADWIRE_CLASSIC_PID
$expectedCreationTime = [string]$env:THREADWIRE_CLASSIC_CREATION_TIME
$listeners = @(Get-NetTCPConnection -State Listen -LocalAddress $hostAddress -LocalPort $port -ErrorAction Stop)
if ($listeners.Count -ne 1) {
  throw 'Configured CDP listener ownership is not unique.'
}
$ownerPid = [int]$listeners[0].OwningProcess
if ($ownerPid -le 0) {
  throw 'Configured CDP listener owner is invalid.'
}
$chain = @()
$seen = @{}
$currentPid = $ownerPid
for ($depth = 0; $depth -lt ${MAX_ANCESTRY_DEPTH}; $depth++) {
  if ($seen.ContainsKey($currentPid)) {
    throw 'Process ancestry contains a cycle.'
  }
  $seen[$currentPid] = $true
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $currentPid" -ErrorAction Stop
  if ($null -eq $process) {
    throw 'Process ancestry could not be observed.'
  }
  $creationTime = $process.CreationDate.ToUniversalTime().ToString('O')
  $chain += [pscustomobject]@{
    pid = [int]$process.ProcessId
    parentPid = [int]$process.ParentProcessId
    creationTime = $creationTime
  }
  if ([int]$process.ProcessId -eq $expectedPid) {
    if ($creationTime -ne $expectedCreationTime) {
      throw 'Admitted runtime identity no longer matches.'
    }
    break
  }
  $parentPid = [int]$process.ParentProcessId
  if ($parentPid -le 0) {
    throw 'Listener owner is outside the admitted runtime ancestry.'
  }
  $currentPid = $parentPid
}
if ([int]$chain[-1].pid -ne $expectedPid) {
  throw 'Process ancestry exceeded the bounded inspection depth.'
}
[pscustomobject]@{
  ownerPid = $ownerPid
  chain = @($chain)
} | ConvertTo-Json -Depth 4 -Compress
`;

interface ObservedProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly creationTime: string;
}

interface ListenerProvenanceObservation {
  readonly ownerPid: number;
  readonly chain: readonly ObservedProcessIdentity[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositivePid(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeProvenanceUnverifiedError();
  }
  return value;
}

function parseProcess(value: unknown): ObservedProcessIdentity {
  if (!isRecord(value)) {
    throw new RuntimeProvenanceUnverifiedError();
  }
  const pid = parsePositivePid(value.pid);
  const parentPid = value.parentPid;
  const creationTime = value.creationTime;
  if (
    typeof parentPid !== "number" ||
    !Number.isSafeInteger(parentPid) ||
    parentPid < 0 ||
    typeof creationTime !== "string" ||
    creationTime.length === 0 ||
    !Number.isFinite(Date.parse(creationTime))
  ) {
    throw new RuntimeProvenanceUnverifiedError();
  }
  return { pid, parentPid, creationTime };
}

export function parseListenerProvenanceOutput(output: string): ListenerProvenanceObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new RuntimeProvenanceUnverifiedError(undefined, { cause: error });
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.chain)) {
    throw new RuntimeProvenanceUnverifiedError();
  }
  const ownerPid = parsePositivePid(parsed.ownerPid);
  const chain = parsed.chain.map(parseProcess);
  if (chain.length === 0 || chain.length > MAX_ANCESTRY_DEPTH || chain[0]!.pid !== ownerPid) {
    throw new RuntimeProvenanceUnverifiedError();
  }
  for (let index = 0; index < chain.length - 1; index += 1) {
    const child = chain[index]!;
    const parent = chain[index + 1]!;
    if (child.parentPid !== parent.pid || Date.parse(parent.creationTime) > Date.parse(child.creationTime)) {
      throw new RuntimeProvenanceUnverifiedError();
    }
  }
  return { ownerPid, chain };
}

export interface CdpEndpointProvenanceSource {
  assertOwnedByRuntime(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void>;
}

export class WindowsCdpEndpointProvenance implements CdpEndpointProvenanceSource {
  public constructor(
    private readonly config: ControllerConfig,
    private readonly runner: CommandRunner = new NodeCommandRunner(),
  ) {}

  public async assertOwnedByRuntime(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void> {
    try {
      const result = await this.runner.run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", LISTENER_PROVENANCE_SCRIPT],
        {
          ...(signal ? { signal } : {}),
          env: {
            ...process.env,
            THREADWIRE_CDP_HOST: this.config.cdpHost,
            THREADWIRE_CDP_PORT: String(this.config.cdpPort),
            THREADWIRE_CLASSIC_PID: String(expectedLease.identity.pid),
            THREADWIRE_CLASSIC_CREATION_TIME: expectedLease.identity.creationTime,
          },
        },
      );
      const observation = parseListenerProvenanceOutput(result.stdout.trim());
      const admittedRuntimeObserved = observation.chain.some((process) =>
        sameRuntimeIdentity(
          { pid: process.pid, creationTime: process.creationTime },
          expectedLease.identity,
        ),
      );
      if (!admittedRuntimeObserved) {
        throw new RuntimeProvenanceUnverifiedError();
      }
    } catch (error) {
      if (error instanceof OperationAbortedError || error instanceof RuntimeProvenanceUnverifiedError) {
        throw error;
      }
      throw new RuntimeProvenanceUnverifiedError(undefined, { cause: error });
    }
  }
}
