import path from "node:path";
import { ControllerConfig } from "../config/ControllerConfig.js";
import { CommandRunOptions } from "./CommandRunner.js";

const POWERSHELL_LAUNCH_SCRIPT = `
$ErrorActionPreference = 'Stop'
$exe = $env:THREADWIRE_CLASSIC_EXECUTABLE
$hostAddress = $env:THREADWIRE_CDP_HOST
$port = $env:THREADWIRE_CDP_PORT
if ([string]::IsNullOrWhiteSpace($exe) -or [string]::IsNullOrWhiteSpace($hostAddress) -or [string]::IsNullOrWhiteSpace($port)) {
  throw 'Missing Threadwire launch environment.'
}
if ($exe.Contains('"')) {
  throw 'Invalid executable path.'
}
$commandLine = '"' + $exe + '" --remote-debugging-address=' + $hostAddress + ' --remote-debugging-port=' + $port
$wshell = New-Object -ComObject WScript.Shell
[void]$wshell.Run($commandLine, 1, $false)
`;

export interface ClassicLaunchInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: CommandRunOptions;
}

function validateExecutablePath(executablePath: string): void {
  if (
    !path.win32.isAbsolute(executablePath) ||
    executablePath.includes('"') ||
    executablePath.includes("\0") ||
    executablePath.includes("\r") ||
    executablePath.includes("\n")
  ) {
    throw new TypeError("Classic executable path is not a valid absolute Windows executable path.");
  }
}

export function buildClassicWscriptCommandLine(executablePath: string, config: ControllerConfig): string {
  validateExecutablePath(executablePath);
  return `"${executablePath}" --remote-debugging-address=${config.cdpHost} --remote-debugging-port=${config.cdpPort}`;
}

export function buildClassicLaunchInvocation(
  executablePath: string,
  config: ControllerConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): ClassicLaunchInvocation {
  buildClassicWscriptCommandLine(executablePath, config);
  return {
    file: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_LAUNCH_SCRIPT],
    options: {
      env: {
        ...baseEnv,
        THREADWIRE_CLASSIC_EXECUTABLE: executablePath,
        THREADWIRE_CDP_HOST: config.cdpHost,
        THREADWIRE_CDP_PORT: String(config.cdpPort),
      },
    },
  };
}
