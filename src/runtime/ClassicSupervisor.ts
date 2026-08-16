import { ControllerConfig } from "../config/ControllerConfig.js";
import {
  RuntimeGeneration,
  RuntimeGenerationTracker,
  RuntimeIdentity,
  RuntimeLease,
  RuntimeLeaseSource,
  runtimeGenerationNumber,
  sameRuntimeIdentity,
} from "../domain/RuntimeGeneration.js";
import { ClassicProcessInfo, ClassicRuntimeSnapshot } from "../domain/RuntimeState.js";
import {
  ClassicStartFailedError,
  ClassicStopFailedError,
  NewProcessNotObservedError,
  OperationAbortedError,
  OperationTimeoutError,
  ProcessExitTimeoutError,
} from "../domain/errors.js";
import { delay, withTimeout } from "../utils/timeout.js";
import {
  ClassicInstallationResolver,
  ClassicInstallationSource,
} from "./ClassicInstallationResolver.js";
import { buildClassicLaunchInvocation } from "./ClassicLaunchCommand.js";
import { CommandRunner, NodeCommandRunner } from "./CommandRunner.js";
import {
  ClassicProcessInspector,
  ProcessInspector,
  selectUniqueMainProcess,
} from "./ProcessInspector.js";

const DEFAULT_PROCESS_POLL_INTERVAL_MS = 250;
const DEFAULT_PROCESS_STOP_TIMEOUT_MS = 5000;
const DEFAULT_PROCESS_START_TIMEOUT_MS = 10000;

const STOP_PROCESS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$pids = @($env:THREADWIRE_CLASSIC_PIDS.Split(',') | ForEach-Object { [int]$_ })
Get-Process -Id $pids -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction Stop
`;

export interface ClassicSupervisorOptions {
  readonly inspector?: ClassicProcessInspector;
  readonly resolver?: ClassicInstallationSource;
  readonly runner?: CommandRunner;
  readonly processPollIntervalMs?: number;
  readonly processStopTimeoutMs?: number;
  readonly processStartTimeoutMs?: number;
}

function runtimeIdentity(process: ClassicProcessInfo): RuntimeIdentity {
  return { pid: process.pid, creationTime: process.creationTime };
}

function processMatchesIdentity(process: ClassicProcessInfo, identity: RuntimeIdentity): boolean {
  return sameRuntimeIdentity(runtimeIdentity(process), identity);
}

export class ClassicSupervisor implements RuntimeLeaseSource {
  private readonly tracker = new RuntimeGenerationTracker();
  private readonly inspector: ClassicProcessInspector;
  private readonly resolver: ClassicInstallationSource;
  private readonly runner: CommandRunner;
  private readonly processPollIntervalMs: number;
  private readonly processStopTimeoutMs: number;
  private readonly processStartTimeoutMs: number;

  public constructor(
    private readonly config: ControllerConfig,
    options: ClassicSupervisorOptions = {},
  ) {
    this.inspector = options.inspector ?? new ProcessInspector();
    this.resolver = options.resolver ?? new ClassicInstallationResolver();
    this.runner = options.runner ?? new NodeCommandRunner();
    this.processPollIntervalMs = options.processPollIntervalMs ?? DEFAULT_PROCESS_POLL_INTERVAL_MS;
    this.processStopTimeoutMs = options.processStopTimeoutMs ?? DEFAULT_PROCESS_STOP_TIMEOUT_MS;
    this.processStartTimeoutMs = options.processStartTimeoutMs ?? DEFAULT_PROCESS_START_TIMEOUT_MS;
  }

  public get currentGeneration(): RuntimeGeneration {
    return this.tracker.currentGeneration;
  }

  public getCurrentRuntimeLease(): RuntimeLease {
    return this.tracker.getCurrentRuntimeLease();
  }

  public assertRuntimeLeaseCurrent(lease: RuntimeLease): void {
    this.tracker.assertRuntimeLeaseCurrent(lease);
  }

  public async inspect(signal?: AbortSignal): Promise<ClassicRuntimeSnapshot> {
    const processes = await this.inspector.getClassicProcesses(signal);
    const mainProcess = selectUniqueMainProcess(processes);
    const generation = this.tracker.observe(mainProcess ? runtimeIdentity(mainProcess) : null);
    return {
      isRunning: mainProcess !== null,
      pid: mainProcess?.pid ?? null,
      generation,
      mainProcess,
      processes: processes.map((process) => ({ ...process })),
    };
  }

  public async ensureStarted(signal?: AbortSignal): Promise<RuntimeGeneration> {
    const snapshot = await this.inspect(signal);
    if (snapshot.isRunning) {
      return snapshot.generation;
    }
    return await this.startNewGeneration(signal);
  }

  public async stop(signal?: AbortSignal): Promise<void> {
    const processes = await this.inspector.getClassicProcesses(signal);
    const mainProcess = selectUniqueMainProcess(processes);
    if (mainProcess) {
      this.tracker.observe(runtimeIdentity(mainProcess));
    }

    if (processes.length === 0) {
      this.tracker.observe(null);
      return;
    }

    const previousIdentities = processes.map(runtimeIdentity);
    const pidList = processes.map((process) => process.pid).join(",");

    try {
      await this.runner.run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", STOP_PROCESS_SCRIPT],
        {
          ...(signal ? { signal } : {}),
          env: { ...process.env, THREADWIRE_CLASSIC_PIDS: pidList },
        },
      );
    } catch (error) {
      if (error instanceof OperationAbortedError) {
        throw error;
      }
      throw new ClassicStopFailedError(undefined, { cause: error });
    }

    try {
      await withTimeout(
        async (waitSignal) => {
          while (true) {
            const remaining = await this.inspector.getClassicProcesses(waitSignal);
            const previousStillPresent = previousIdentities.some((identity) =>
              remaining.some((process) => processMatchesIdentity(process, identity)),
            );
            if (!previousStillPresent) {
              if (remaining.length !== 0) {
                throw new ClassicStopFailedError(
                  "A different ChatGPT Classic runtime appeared while stopping the previous runtime.",
                );
              }
              this.tracker.observe(null);
              return;
            }
            await delay(this.processPollIntervalMs, waitSignal);
          }
        },
        this.processStopTimeoutMs,
        signal ? { signal, message: "Timed out waiting for Classic process exit." } : { message: "Timed out waiting for Classic process exit." },
      );
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        throw new ProcessExitTimeoutError(undefined, { cause: error });
      }
      throw error;
    }
  }

  public async restart(signal?: AbortSignal): Promise<RuntimeGeneration> {
    await this.stop(signal);
    return await this.startNewGeneration(signal);
  }

  private async startNewGeneration(signal?: AbortSignal): Promise<RuntimeGeneration> {
    const generationBeforeLaunch = this.tracker.currentGeneration;
    const installation = await this.resolver.resolve(signal);
    const invocation = buildClassicLaunchInvocation(installation.executablePath, this.config);

    try {
      await this.runner.run(
        invocation.file,
        invocation.args,
        {
          ...invocation.options,
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      if (error instanceof OperationAbortedError) {
        throw error;
      }
      throw new ClassicStartFailedError(undefined, { cause: error });
    }

    try {
      return await withTimeout(
        async (waitSignal) => {
          while (true) {
            const processes = await this.inspector.getClassicProcesses(waitSignal);
            const mainProcess = selectUniqueMainProcess(processes);
            if (mainProcess) {
              const generation = this.tracker.observe(runtimeIdentity(mainProcess));
              if (runtimeGenerationNumber(generation) > runtimeGenerationNumber(generationBeforeLaunch)) {
                return generation;
              }
            }
            await delay(this.processPollIntervalMs, waitSignal);
          }
        },
        this.processStartTimeoutMs,
        signal ? { signal, message: "Timed out waiting for a new Classic Main process." } : { message: "Timed out waiting for a new Classic Main process." },
      );
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        throw new NewProcessNotObservedError(undefined, { cause: error });
      }
      throw error;
    }
  }
}
