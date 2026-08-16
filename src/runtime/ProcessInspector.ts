import {
  ClassicProcessInfo,
  ClassicProcessRole,
} from "../domain/RuntimeState.js";
import {
  ClassicProcessTopologyError,
  OperationAbortedError,
  ProcessInspectionFailedError,
} from "../domain/errors.js";
import { CommandRunner, NodeCommandRunner } from "./CommandRunner.js";

const PROCESS_QUERY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$procs = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT Classic.exe'" -ErrorAction Stop)
$result = @()
foreach ($p in $procs) {
  $result += [pscustomobject]@{
    pid = [int]$p.ProcessId
    parentPid = [int]$p.ParentProcessId
    commandLine = if ($null -eq $p.CommandLine) { $null } else { [string]$p.CommandLine }
    creationTime = $p.CreationDate.ToUniversalTime().ToString('O')
  }
}
ConvertTo-Json -InputObject @($result) -Compress
`;

interface RawClassicProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly commandLine: string | null;
  readonly creationTime: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRawProcess(value: unknown): RawClassicProcess {
  if (!isRecord(value)) {
    throw new ProcessInspectionFailedError();
  }

  const { pid, parentPid, commandLine, creationTime } = value;
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof parentPid !== "number" ||
    !Number.isInteger(parentPid) ||
    parentPid < 0 ||
    (commandLine !== null && typeof commandLine !== "string") ||
    typeof creationTime !== "string" ||
    creationTime.length === 0
  ) {
    throw new ProcessInspectionFailedError();
  }

  return { pid, parentPid, commandLine, creationTime };
}

function classifyRole(process: RawClassicProcess, classicPids: ReadonlySet<number>): ClassicProcessRole {
  const hasChromiumType = process.commandLine !== null && /(?:^|\s)--type(?:=|\s)/i.test(process.commandLine);
  const parentIsClassic = classicPids.has(process.parentPid);
  return !hasChromiumType && !parentIsClassic ? "MAIN" : "CHILD";
}

export function parseClassicProcessOutput(output: string): ClassicProcessInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new ProcessInspectionFailedError(undefined, { cause: error });
  }

  if (!Array.isArray(parsed)) {
    throw new ProcessInspectionFailedError();
  }

  const rawProcesses = parsed.map(parseRawProcess);
  const pids = new Set(rawProcesses.map((process) => process.pid));
  return rawProcesses.map((process) => ({
    ...process,
    role: classifyRole(process, pids),
  }));
}

export function selectUniqueMainProcess(processes: readonly ClassicProcessInfo[]): ClassicProcessInfo | null {
  if (processes.length === 0) {
    return null;
  }

  const mains = processes.filter((process) => process.role === "MAIN");
  if (mains.length !== 1) {
    throw new ClassicProcessTopologyError();
  }
  return mains[0] ?? null;
}

export interface ClassicProcessInspector {
  getClassicProcesses(signal?: AbortSignal): Promise<ClassicProcessInfo[]>;
}

export class ProcessInspector implements ClassicProcessInspector {
  public constructor(private readonly runner: CommandRunner = new NodeCommandRunner()) {}

  public async getClassicProcesses(signal?: AbortSignal): Promise<ClassicProcessInfo[]> {
    try {
      const result = await this.runner.run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", PROCESS_QUERY_SCRIPT],
        signal ? { signal } : undefined,
      );

      const output = result.stdout.trim();
      if (output.length === 0) {
        throw new ProcessInspectionFailedError();
      }
      return parseClassicProcessOutput(output);
    } catch (error) {
      if (error instanceof OperationAbortedError || error instanceof ProcessInspectionFailedError) {
        throw error;
      }
      throw new ProcessInspectionFailedError(undefined, { cause: error });
    }
  }

  public async getMainProcess(signal?: AbortSignal): Promise<ClassicProcessInfo | null> {
    return selectUniqueMainProcess(await this.getClassicProcesses(signal));
  }
}
