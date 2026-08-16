import { execFile } from "child_process";
import { promisify } from "util";
import { ClassicRuntimeSnapshot } from "../domain/RuntimeState.js";
import { RuntimeGeneration } from "../domain/RuntimeGeneration.js";
import { ProcessInspector, ProcessInfo } from "./ProcessInspector.js";
import { ClassicInstallationResolver } from "./ClassicInstallationResolver.js";
import { ControllerConfig } from "../config/ControllerConfig.js";
import { ClassicStartFailedError, ClassicStopFailedError, ProcessExitTimeoutError, NewProcessNotObservedError } from "../domain/errors.js";

const execFileAsync = promisify(execFile);

const PROCESS_POLL_INTERVAL_MS = 250;
const PROCESS_STOP_TIMEOUT_MS = 5000;
const PROCESS_START_TIMEOUT_MS = 10000;

export class ClassicSupervisor {
  private currentGeneration: RuntimeGeneration = 0;
  private inspector: ProcessInspector;
  private resolver: ClassicInstallationResolver;
  private config: ControllerConfig;

  constructor(config: ControllerConfig) {
    this.config = config;
    this.inspector = new ProcessInspector();
    this.resolver = new ClassicInstallationResolver();
  }

  public async inspect(): Promise<ClassicRuntimeSnapshot> {
    const mainProc = await this.inspector.getMainProcess();
    return {
      isRunning: mainProc !== null,
      pid: mainProc ? mainProc.pid : null,
      generation: this.currentGeneration,
    };
  }

  public async ensureStarted(): Promise<RuntimeGeneration> {
    const snapshot = await this.inspect();
    if (snapshot.isRunning) {
      if (this.currentGeneration === 0) {
        // We found it running but didn't track it yet. Track it as gen 1.
        this.currentGeneration = 1;
      }
      return this.currentGeneration;
    }
    return this.startNewGeneration();
  }

  public async stop(): Promise<void> {
    const procs = await this.inspector.getClassicProcesses();
    if (procs.length === 0) {
      return; // Already stopped
    }

    const pids = procs.map(p => p.pid);
    const pidsStr = pids.join(",");

    try {
      await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Stop-Process -Id ${pidsStr} -Force -ErrorAction SilentlyContinue`,
      ], { windowsHide: true });
    } catch (err: any) {
      // Ignored. The process might have exited already.
    }

    // Wait for them to exit
    const startWait = Date.now();
    while (Date.now() - startWait < PROCESS_STOP_TIMEOUT_MS) {
      const remainingProcs = await this.inspector.getClassicProcesses();
      if (remainingProcs.length === 0) {
        return; // All exited
      }
      await new Promise(r => setTimeout(r, PROCESS_POLL_INTERVAL_MS));
    }

    throw new ProcessExitTimeoutError();
  }

  public async restart(): Promise<RuntimeGeneration> {
    await this.stop();
    return this.startNewGeneration();
  }

  private async startNewGeneration(): Promise<RuntimeGeneration> {
    const installation = await this.resolver.resolve();
    
    // We expect the executable path and arguments to be clean
    const exePath = installation.executablePath.replace(/'/g, "''"); // escape single quotes for powershell
    
    // Launch using WScript.Shell to preserve CDP arguments
    const script = `
      $wshell = New-Object -ComObject WScript.Shell
      $wshell.Run('"${exePath}" --remote-debugging-address=${this.config.cdpHost} --remote-debugging-port=${this.config.cdpPort}')
    `;

    try {
      await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        script
      ], { windowsHide: true });
    } catch (err: any) {
      throw new ClassicStartFailedError(`Failed to launch process: ${err.message}`);
    }

    // Wait for the new main process to be observed
    const startWait = Date.now();
    while (Date.now() - startWait < PROCESS_START_TIMEOUT_MS) {
      const mainProc = await this.inspector.getMainProcess();
      if (mainProc) {
        this.currentGeneration += 1;
        return this.currentGeneration;
      }
      await new Promise(r => setTimeout(r, PROCESS_POLL_INTERVAL_MS));
    }

    throw new NewProcessNotObservedError();
  }
}
