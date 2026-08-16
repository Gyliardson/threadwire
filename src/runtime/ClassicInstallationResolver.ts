import path from "node:path";
import {
  ClassicInstallationNotFoundError,
  ClassicInstallationQueryFailedError,
  OperationAbortedError,
} from "../domain/errors.js";
import { CommandRunner, NodeCommandRunner } from "./CommandRunner.js";

const INSTALLATION_QUERY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$pkgs = @(Get-AppxPackage -Name 'OpenAI.ChatGPT-Desktop' -ErrorAction Stop)
$result = @()
foreach ($pkg in $pkgs) {
  $exeMatches = @(Get-ChildItem -LiteralPath $pkg.InstallLocation -Filter 'ChatGPT Classic.exe' -Recurse -File -ErrorAction SilentlyContinue)
  foreach ($exe in $exeMatches) {
    $result += [pscustomobject]@{
      executablePath = [string]$exe.FullName
      packageVersion = $pkg.Version.ToString()
      packageFullName = [string]$pkg.PackageFullName
    }
  }
}
ConvertTo-Json -InputObject @($result) -Compress
`;

export interface ClassicInstallation {
  readonly executablePath: string;
  readonly packageVersion: string;
  readonly packageFullName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseVersion(version: string): readonly number[] {
  if (!/^\d+(?:\.\d+){3}$/.test(version)) {
    throw new ClassicInstallationQueryFailedError();
  }
  return version.split(".").map((part) => Number(part));
}

function compareVersionsDescending(left: ClassicInstallation, right: ClassicInstallation): number {
  const leftParts = parseVersion(left.packageVersion);
  const rightParts = parseVersion(right.packageVersion);
  for (let index = 0; index < 4; index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.packageFullName.localeCompare(right.packageFullName);
}

function parseInstallation(value: unknown): ClassicInstallation {
  if (!isRecord(value)) {
    throw new ClassicInstallationQueryFailedError();
  }

  const { executablePath, packageVersion, packageFullName } = value;
  if (
    typeof executablePath !== "string" ||
    !path.win32.isAbsolute(executablePath) ||
    typeof packageVersion !== "string" ||
    typeof packageFullName !== "string" ||
    packageFullName.length === 0
  ) {
    throw new ClassicInstallationQueryFailedError();
  }

  parseVersion(packageVersion);
  return { executablePath, packageVersion, packageFullName };
}

export function parseClassicInstallationOutput(output: string): ClassicInstallation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new ClassicInstallationQueryFailedError(undefined, { cause: error });
  }

  if (!Array.isArray(parsed)) {
    throw new ClassicInstallationQueryFailedError();
  }

  return parsed.map(parseInstallation).sort(compareVersionsDescending);
}

export interface ClassicInstallationSource {
  resolve(signal?: AbortSignal): Promise<ClassicInstallation>;
}

export class ClassicInstallationResolver implements ClassicInstallationSource {
  public constructor(private readonly runner: CommandRunner = new NodeCommandRunner()) {}

  public async resolve(signal?: AbortSignal): Promise<ClassicInstallation> {
    try {
      const result = await this.runner.run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", INSTALLATION_QUERY_SCRIPT],
        signal ? { signal } : undefined,
      );
      const output = result.stdout.trim();
      if (output.length === 0) {
        throw new ClassicInstallationQueryFailedError();
      }
      const installations = parseClassicInstallationOutput(output);
      if (installations.length === 0) {
        throw new ClassicInstallationNotFoundError();
      }

      const selected = installations[0]!;
      
      const ambiguousTies = installations.filter(
        (inst) =>
          inst.packageVersion === selected.packageVersion &&
          inst.packageFullName === selected.packageFullName,
      );

      if (ambiguousTies.length > 1) {
        throw new ClassicInstallationNotFoundError(
          "Ambiguous installation: multiple executables found for the highest Appx version.",
        );
      }

      return selected;
    } catch (error) {
      if (
        error instanceof OperationAbortedError ||
        error instanceof ClassicInstallationNotFoundError ||
        error instanceof ClassicInstallationQueryFailedError
      ) {
        throw error;
      }
      throw new ClassicInstallationQueryFailedError(undefined, { cause: error });
    }
  }
}
