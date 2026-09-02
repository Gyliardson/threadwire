import { ControllerConfig } from "../config/ControllerConfig.js";
import {
  RuntimeIdentity,
  RuntimeLease,
  sameRuntimeIdentity,
} from "../domain/RuntimeGeneration.js";
import {
  OperationAbortedError,
  RuntimeProvenanceUnverifiedError,
} from "../domain/errors.js";
import { CommandRunner, NodeCommandRunner } from "./CommandRunner.js";

const MAX_ANCESTRY_DEPTH = 64;
const CANONICAL_CREATION_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/;

const LISTENER_PROVENANCE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$hostAddress = [string]$env:THREADWIRE_CDP_HOST
$port = [int]$env:THREADWIRE_CDP_PORT
$expectedPid = [int]$env:THREADWIRE_CLASSIC_PID
$expectedCreationTime = [string]$env:THREADWIRE_CLASSIC_CREATION_TIME

function Get-ConfiguredListenerSnapshot {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalAddress $hostAddress -LocalPort $port -ErrorAction Stop)
  if ($listeners.Count -ne 1) {
    throw 'Configured CDP listener ownership is not unique.'
  }
  $listener = $listeners[0]
  $ownerPid = [int]$listener.OwningProcess
  if ($ownerPid -le 0) {
    throw 'Configured CDP listener owner is invalid.'
  }
  return [pscustomobject]@{
    listenerCount = [int]$listeners.Count
    localAddress = [string]$listener.LocalAddress
    localPort = [int]$listener.LocalPort
    ownerPid = $ownerPid
  }
}

function Get-AncestrySnapshot([int]$ownerPid) {
  $chain = @()
  $seen = @{}
  $currentPid = $ownerPid
  for ($depth = 0; $depth -lt ${MAX_ANCESTRY_DEPTH}; $depth++) {
    if ($seen.ContainsKey($currentPid)) {
      throw 'Process ancestry contains a cycle.'
    }
    $seen[$currentPid] = $true
    $processMatches = @(Get-CimInstance Win32_Process -Filter "ProcessId = $currentPid" -ErrorAction Stop)
    if ($processMatches.Count -ne 1) {
      throw 'Process ancestry could not be observed uniquely.'
    }
    $process = $processMatches[0]
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
      return $chain
    }
    $parentPid = [int]$process.ParentProcessId
    if ($parentPid -le 0) {
      throw 'Listener owner is outside the admitted runtime ancestry.'
    }
    $currentPid = $parentPid
  }
  throw 'Process ancestry exceeded the bounded inspection depth.'
}

$listenerA = Get-ConfiguredListenerSnapshot
$chainA = @(Get-AncestrySnapshot $listenerA.ownerPid)
$listenerB = Get-ConfiguredListenerSnapshot
if (
  [int]$listenerB.listenerCount -ne [int]$listenerA.listenerCount -or
  [string]$listenerB.localAddress -ne [string]$listenerA.localAddress -or
  [int]$listenerB.localPort -ne [int]$listenerA.localPort -or
  [int]$listenerB.ownerPid -ne [int]$listenerA.ownerPid
) {
  throw 'Configured CDP listener changed during provenance observation.'
}
$chainB = @(Get-AncestrySnapshot $listenerB.ownerPid)
if ($chainA.Count -ne $chainB.Count) {
  throw 'Process ancestry changed during provenance observation.'
}
for ($index = 0; $index -lt $chainA.Count; $index++) {
  if (
    [int]$chainA[$index].pid -ne [int]$chainB[$index].pid -or
    [int]$chainA[$index].parentPid -ne [int]$chainB[$index].parentPid -or
    [string]$chainA[$index].creationTime -ne [string]$chainB[$index].creationTime
  ) {
    throw 'Process identity changed during provenance observation.'
  }
}

[pscustomobject]@{
  listenerA = $listenerA
  chainA = @($chainA)
  listenerB = $listenerB
  chainB = @($chainB)
} | ConvertTo-Json -Depth 5 -Compress
`;

interface ObservedProcessIdentity extends RuntimeIdentity {
  readonly parentPid: number;
}

interface ListenerSnapshot {
  readonly listenerCount: number;
  readonly localAddress: string;
  readonly localPort: number;
  readonly ownerPid: number;
}

export interface ListenerProvenanceObservation {
  readonly listenerA: ListenerSnapshot;
  readonly chainA: readonly ObservedProcessIdentity[];
  readonly listenerB: ListenerSnapshot;
  readonly chainB: readonly ObservedProcessIdentity[];
  readonly ownerIdentity: RuntimeIdentity;
}

export type ListenerEndpointBinding = Readonly<{
  ownerIdentity: RuntimeIdentity;
}>;

type CdpEndpointConfig = Pick<ControllerConfig, "cdpHost" | "cdpPort">;

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
    !CANONICAL_CREATION_TIME.test(creationTime) ||
    !Number.isFinite(Date.parse(creationTime))
  ) {
    throw new RuntimeProvenanceUnverifiedError();
  }
  return { pid, parentPid, creationTime };
}

function parseListenerSnapshot(
  value: unknown,
  expectedEndpoint: CdpEndpointConfig,
): ListenerSnapshot {
  if (!isRecord(value)) {
    throw new RuntimeProvenanceUnverifiedError();
  }
  const listenerCount = value.listenerCount;
  const localAddress = value.localAddress;
  const localPort = value.localPort;
  const ownerPid = parsePositivePid(value.ownerPid);
  if (
    listenerCount !== 1 ||
    localAddress !== expectedEndpoint.cdpHost ||
    localPort !== expectedEndpoint.cdpPort
  ) {
    throw new RuntimeProvenanceUnverifiedError();
  }
  return { listenerCount, localAddress, localPort, ownerPid };
}

function parseAncestry(
  value: unknown,
  ownerPid: number,
  expectedLease: RuntimeLease,
): readonly ObservedProcessIdentity[] {
  if (!Array.isArray(value)) {
    throw new RuntimeProvenanceUnverifiedError();
  }
  const chain = value.map(parseProcess);
  if (chain.length === 0 || chain.length > MAX_ANCESTRY_DEPTH || chain[0]!.pid !== ownerPid) {
    throw new RuntimeProvenanceUnverifiedError();
  }

  const seenPids = new Set<number>();
  for (const process of chain) {
    if (seenPids.has(process.pid)) {
      throw new RuntimeProvenanceUnverifiedError();
    }
    seenPids.add(process.pid);
  }

  for (let index = 0; index < chain.length - 1; index += 1) {
    const child = chain[index]!;
    const parent = chain[index + 1]!;
    if (child.parentPid !== parent.pid || parent.creationTime >= child.creationTime) {
      throw new RuntimeProvenanceUnverifiedError();
    }
  }

  const root = chain[chain.length - 1]!;
  if (!sameRuntimeIdentity(root, expectedLease.identity)) {
    throw new RuntimeProvenanceUnverifiedError();
  }
  return chain;
}

function sameObservedProcess(
  left: ObservedProcessIdentity,
  right: ObservedProcessIdentity,
): boolean {
  return (
    left.pid === right.pid &&
    left.parentPid === right.parentPid &&
    left.creationTime === right.creationTime
  );
}

function sameAncestry(
  left: readonly ObservedProcessIdentity[],
  right: readonly ObservedProcessIdentity[],
): boolean {
  return (
    left.length === right.length &&
    left.every((process, index) => sameObservedProcess(process, right[index]!))
  );
}

export function parseListenerProvenanceOutput(
  output: string,
  expectedEndpoint: CdpEndpointConfig,
  expectedLease: RuntimeLease,
): ListenerProvenanceObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new RuntimeProvenanceUnverifiedError(undefined, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new RuntimeProvenanceUnverifiedError();
  }

  const listenerA = parseListenerSnapshot(parsed.listenerA, expectedEndpoint);
  const listenerB = parseListenerSnapshot(parsed.listenerB, expectedEndpoint);
  if (listenerA.ownerPid !== listenerB.ownerPid) {
    throw new RuntimeProvenanceUnverifiedError();
  }

  const chainA = parseAncestry(parsed.chainA, listenerA.ownerPid, expectedLease);
  const chainB = parseAncestry(parsed.chainB, listenerB.ownerPid, expectedLease);
  if (!sameAncestry(chainA, chainB)) {
    throw new RuntimeProvenanceUnverifiedError();
  }

  return {
    listenerA,
    chainA,
    listenerB,
    chainB,
    ownerIdentity: {
      pid: chainB[0]!.pid,
      creationTime: chainB[0]!.creationTime,
    },
  };
}

export interface CdpEndpointProvenanceSource {
  bindOwnedEndpoint(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void>;
  assertOwnedEndpointCurrent(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void>;
}

export class WindowsCdpEndpointProvenance implements CdpEndpointProvenanceSource {
  private binding: ListenerEndpointBinding | null = null;

  public constructor(
    private readonly config: ControllerConfig,
    private readonly runner: CommandRunner = new NodeCommandRunner(),
  ) {}

  public async bindOwnedEndpoint(expectedLease: RuntimeLease, signal?: AbortSignal): Promise<void> {
    if (this.binding !== null) {
      throw new RuntimeProvenanceUnverifiedError();
    }
    const observation = await this.observe(expectedLease, signal);
    this.binding = Object.freeze({
      ownerIdentity: Object.freeze({ ...observation.ownerIdentity }),
    });
  }

  public async assertOwnedEndpointCurrent(
    expectedLease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    const binding = this.binding;
    if (binding === null) {
      throw new RuntimeProvenanceUnverifiedError();
    }
    const observation = await this.observe(expectedLease, signal);
    if (!sameRuntimeIdentity(observation.ownerIdentity, binding.ownerIdentity)) {
      throw new RuntimeProvenanceUnverifiedError();
    }
  }

  private async observe(
    expectedLease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<ListenerProvenanceObservation> {
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
      return parseListenerProvenanceOutput(result.stdout.trim(), this.config, expectedLease);
    } catch (error) {
      if (error instanceof OperationAbortedError || error instanceof RuntimeProvenanceUnverifiedError) {
        throw error;
      }
      throw new RuntimeProvenanceUnverifiedError(undefined, { cause: error });
    }
  }
}
