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
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}
