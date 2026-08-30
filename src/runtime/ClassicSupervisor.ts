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
import { ClassicProcessObservation, ClassicRuntimeSnapshot } from "../domain/RuntimeState.js";
import {
  ClassicStartFailedError,
  ClassicStopFailedError,
  NewProcessNotObservedError,
  OperationAbortedError,
  OperationTimeoutError,
  ProcessExitTimeoutError,
} from "../domain/errors.js";
import { delay, throwIfAborted, withTimeout } from "../utils/timeout.js";
import {
  ClassicInstallationResolver,
  ClassicInstallationSource,
} from "./ClassicInstallationResolver.js";
import { buildClassicLaunchInvocation } from "./ClassicLaunchCommand.js";
import { CommandRunner, NodeCommandRunner } from "./CommandRunner.js";
import {
  ClassicProcessInfo,
  ClassicProcessInspector,
  ProcessInspector,
  selectUniqueMainProcess,
} from "./ProcessInspector.js";

const DEFAULT_PROCESS_POLL_INTERVAL_MS = 250;
const DEFAULT_PROCESS_STOP_TIMEOUT_MS = 5000;
const DEFAULT_PROCESS_START_TIMEOUT_MS = 10000;
const REQUIRED_STOP_QUIESCENT_OBSERVATIONS = 2;

const STOP_PROCESS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$expectedProcesses = $env:THREADWIRE_CLASSIC_IDENTITIES | ConvertFrom-Json -ErrorAction Stop
foreach ($expected in $expectedProcesses) {
  $process = Get-Process -Id ([int]$expected.pid) -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    continue
  }

  $actualCreationTicks = [long]$process.StartTime.ToUniversalTime().Ticks
  $expectedCreationTicks = [long]([DateTimeOffset]::Parse([string]$expected.creationTime).UtcDateTime.Ticks)
  $actualCanonicalTicks = [long]($actualCreationTicks - ($actualCreationTicks % 10))
  $expectedCanonicalTicks = [long]($expectedCreationTicks - ($expectedCreationTicks % 10))
  if ($actualCanonicalTicks -ne $expectedCanonicalTicks) {
    throw "Classic process identity changed before termination."
  }

  try {
    $process.Kill()
  } catch {
    if (-not $process.HasExited) {
      throw
    }
  }
}
exit 0
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

function processObservation(process: ClassicProcessInfo): ClassicProcessObservation {
  return {
    pid: process.pid,
    parentPid: process.parentPid,
    creationTime: process.creationTime,
    role: process.role,
  };
}

export class ClassicSupervisor implements RuntimeLeaseSource {
  private readonly tracker = new RuntimeGenerationTracker();
  private readonly inspector: ClassicProcessInspector;
  private readonly resolver: ClassicInstallationSource;
  private readonly runner: CommandRunner;
  private readonly processPollIntervalMs: number;
  private readonly processStopTimeoutMs: number;
  private readonly processStartTimeoutMs: number;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private stopInProgress = false;

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
    const generation = this.stopInProgress
      ? this.tracker.currentGeneration
      : this.tracker.observe(mainProcess ? runtimeIdentity(mainProcess) : null);
    return {
      isRunning: mainProcess !== null,
      pid: mainProcess?.pid ?? null,
      generation,
      mainProcess: mainProcess ? processObservation(mainProcess) : null,
      processes: processes.map(processObservation),
    };
  }

  public ensureStarted(signal?: AbortSignal): Promise<RuntimeGeneration> {
    return this.runLifecycle(async () => {
      throwIfAborted(signal);
      const snapshot = await this.inspect(signal);
      if (snapshot.isRunning) {
        return snapshot.generation;
      }
      return await this.startNewGeneration(signal);
    }, signal);
  }

  public stop(signal?: AbortSignal): Promise<void> {
    return this.runLifecycle(async () => await this.stopExclusive(signal), signal);
  }

  private async stopExclusive(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.stopInProgress = true;
    try {
      await this.stopCapturedProcesses(signal);
    } finally {
      this.stopInProgress = false;
    }
  }

  private async stopCapturedProcesses(signal?: AbortSignal): Promise<void> {
    const processes = await this.inspector.getClassicProcesses(signal);
    const mainProcess = selectUniqueMainProcess(processes);
    if (mainProcess) {
      this.tracker.observe(runtimeIdentity(mainProcess));
    }

    if (processes.length === 0) {
      this.tracker.observe(null);
      return;
    }
    this.tracker.observe(null);

    const previousIdentities = processes.map(runtimeIdentity);
    const serializedIdentities = JSON.stringify(previousIdentities);

    let stopCommandError: unknown;
    try {
      await withTimeout(
        async (commandSignal) => await this.runner.run(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", STOP_PROCESS_SCRIPT],
          {
            signal: commandSignal,
            env: { ...process.env, THREADWIRE_CLASSIC_IDENTITIES: serializedIdentities },
          },
        ),
        this.processStopTimeoutMs,
        signal
          ? { signal, message: "Timed out executing the Classic stop command." }
          : { message: "Timed out executing the Classic stop command." },
      );
    } catch (error) {
      if (error instanceof OperationAbortedError) {
        throw error;
      }
      stopCommandError = error;
    }

    try {
      await withTimeout(
        async (waitSignal) => {
          let quiescentObservations = 0;
          while (true) {
            const remaining = await this.inspector.getClassicProcesses(waitSignal);
            const unexpectedProcessPresent = remaining.some(
              (process) => !previousIdentities.some((identity) => processMatchesIdentity(process, identity)),
            );
            if (unexpectedProcessPresent) {
              this.tracker.observe(null);
              throw new ClassicStopFailedError(
                "A different ChatGPT Classic runtime appeared while stopping the previous runtime.",
              );
            }
            const previousStillPresent = previousIdentities.some((identity) =>
              remaining.some((process) => processMatchesIdentity(process, identity)),
            );
            if (!previousStillPresent) {
              quiescentObservations += 1;
              if (quiescentObservations >= REQUIRED_STOP_QUIESCENT_OBSERVATIONS) {
                this.tracker.observe(null);
                return;
              }
            } else {
              quiescentObservations = 0;
            }
            await delay(this.processPollIntervalMs, waitSignal);
          }
        },
        this.processStopTimeoutMs,
        signal ? { signal, message: "Timed out waiting for Classic process exit." } : { message: "Timed out waiting for Classic process exit." },
      );
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        if (stopCommandError !== undefined) {
          throw new ClassicStopFailedError(undefined, { cause: stopCommandError });
        }
        throw new ProcessExitTimeoutError(undefined, { cause: error });
      }
      throw error;
    }
  }

  public restart(signal?: AbortSignal): Promise<RuntimeGeneration> {
    return this.runLifecycle(async () => {
      throwIfAborted(signal);
      await this.stopExclusive(signal);
      return await this.startNewGeneration(signal);
    }, signal);
  }

  private runLifecycle<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      throwIfAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }

    const scheduled = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = scheduled.then(() => undefined, () => undefined);
    if (!signal) {
      return scheduled;
    }

    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        try {
          throwIfAborted(signal);
        } catch (error) {
          reject(error);
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
    return Promise.race([scheduled, aborted]).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  }

  private async startNewGeneration(signal?: AbortSignal): Promise<RuntimeGeneration> {
    const generationBeforeLaunch = this.tracker.currentGeneration;
    const installation = await this.resolver.resolve(signal);
    const invocation = buildClassicLaunchInvocation(installation.executablePath, this.config);
    const processesBeforeLaunch = await this.inspector.getClassicProcesses(signal);
    if (processesBeforeLaunch.length !== 0) {
      this.tracker.observe(null);
      throw new ClassicStartFailedError(
        "A ChatGPT Classic runtime appeared before the controlled launch began.",
      );
    }

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
