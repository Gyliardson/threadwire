import { execFile } from "node:child_process";
import { OperationAbortedError } from "../domain/errors.js";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunOptions {
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CommandRunner {
  run(file: string, args: readonly string[], options?: CommandRunOptions): Promise<CommandResult>;
}

export class CommandExecutionError extends Error {
  public readonly stdout: string;
  public readonly stderr: string;

  constructor(cause: Error, stdout: string, stderr: string) {
    super(cause.message, { cause });
    this.name = "CommandExecutionError";
    this.stdout = stdout;
    this.stderr = stderr;
    // Non-enumerable to prevent accidental leakage of raw subprocess output
    Object.defineProperty(this, "stdout", { value: stdout, enumerable: false });
    Object.defineProperty(this, "stderr", { value: stderr, enumerable: false });
  }
}

export class NodeCommandRunner implements CommandRunner {
  public async run(file: string, args: readonly string[], options: CommandRunOptions = {}): Promise<CommandResult> {
    return await new Promise<CommandResult>((resolve, reject) => {
      const execOptions = {
        encoding: "utf8" as BufferEncoding,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.env ? { env: options.env } : {}),
      };

      execFile(file, [...args], execOptions, (error, stdout, stderr) => {
        if (error) {
          if (options.signal?.aborted) {
            reject(
              new OperationAbortedError(
                undefined,
                options.signal.reason === undefined ? { cause: error } : { cause: options.signal.reason },
              ),
            );
            return;
          }
          reject(new CommandExecutionError(error, stdout, stderr));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}
