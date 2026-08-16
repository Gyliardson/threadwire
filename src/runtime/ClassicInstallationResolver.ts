import { execFile } from "child_process";
import { promisify } from "util";
import { ClassicInstallationNotFoundError } from "../domain/errors.js";

const execFileAsync = promisify(execFile);

export interface ClassicInstallation {
  executablePath: string;
  packageVersion: string;
  packageFullName: string;
}

export class ClassicInstallationResolver {
  public async resolve(): Promise<ClassicInstallation> {
    const script = `
      $pkg = Get-AppxPackage -Name "OpenAI.ChatGPT-Desktop" -ErrorAction SilentlyContinue
      if ($pkg) {
        $path = Join-Path $pkg.InstallLocation "ChatGPT Classic.exe"
        if (Test-Path $path) {
          $result = @{
            executablePath = $path
            packageVersion = $pkg.Version
            packageFullName = $pkg.PackageFullName
          }
          $result | ConvertTo-Json -Compress
        }
      }
    `;

    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
        windowsHide: true,
      });

      const output = stdout.trim();
      if (!output) {
        throw new ClassicInstallationNotFoundError();
      }

      const parsed = JSON.parse(output);
      if (!parsed.executablePath) {
        throw new ClassicInstallationNotFoundError();
      }

      return {
        executablePath: parsed.executablePath,
        packageVersion: parsed.packageVersion,
        packageFullName: parsed.packageFullName,
      };
    } catch (err: any) {
      if (err instanceof ClassicInstallationNotFoundError) {
        throw err;
      }
      throw new ClassicInstallationNotFoundError(`Failed to query AppxPackage: ${err.message}`);
    }
  }
}
