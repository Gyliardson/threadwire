import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  commandLine: string;
  isMain: boolean;
}

export class ProcessInspector {
  public async getClassicProcesses(): Promise<ProcessInfo[]> {
    const script = `
      $procs = Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT Classic.exe'" -ErrorAction SilentlyContinue
      if ($procs) {
        $result = @()
        foreach ($p in $procs) {
          $isMain = $false
          if ($p.CommandLine -and $p.CommandLine -notmatch '--type=') {
            $isMain = $true
          }
          $result += @{
            pid = [int]$p.ProcessId
            commandLine = $p.CommandLine
            isMain = $isMain
          }
        }
        $result | ConvertTo-Json -Compress
      } else {
        "[]"
      }
    `;

    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
        windowsHide: true,
      });

      const output = stdout.trim();
      if (!output) {
        return [];
      }

      const parsed = JSON.parse(output);
      // Ensure it's an array even if a single object was returned by powershell conversion
      const procs = Array.isArray(parsed) ? parsed : [parsed];

      return procs.map((p: any) => ({
        pid: p.pid,
        commandLine: p.commandLine,
        isMain: p.isMain,
      }));
    } catch (err) {
      // In case of error (e.g. WMI issue), return empty
      return [];
    }
  }

  public async getMainProcess(): Promise<ProcessInfo | null> {
    const procs = await this.getClassicProcesses();
    const main = procs.find((p) => p.isMain);
    return main || null;
  }
}
