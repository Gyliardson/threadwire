import { isAbsolute, join, resolve } from "node:path";
import { InvalidConfigurationError } from "../domain/errors.js";

export const THREAD_REGISTRY_STATE_FILENAME = "thread-registry.v1.json";

export interface ThreadRegistryPersistenceConfig {
  readonly stateDirectory: string;
  readonly stateFile: string;
}

function requireAbsoluteDirectory(value: string, variableName: string): string {
  if (value.trim() === "" || value.includes("\0") || !isAbsolute(value)) {
    throw new InvalidConfigurationError(`${variableName} must be an absolute local directory path.`);
  }
  return resolve(value);
}

export function loadThreadRegistryPersistenceConfig(
  env: NodeJS.ProcessEnv = process.env,
): ThreadRegistryPersistenceConfig {
  const configuredStateDirectory = env.THREADWIRE_STATE_DIR;
  const stateDirectory =
    configuredStateDirectory === undefined
      ? requireAbsoluteDirectory(
          env.LOCALAPPDATA ?? "",
          "LOCALAPPDATA (or set THREADWIRE_STATE_DIR)",
        )
      : requireAbsoluteDirectory(configuredStateDirectory, "THREADWIRE_STATE_DIR");

  const threadwireStateDirectory =
    configuredStateDirectory === undefined ? join(stateDirectory, "Threadwire") : stateDirectory;

  return Object.freeze({
    stateDirectory: threadwireStateDirectory,
    stateFile: join(threadwireStateDirectory, THREAD_REGISTRY_STATE_FILENAME),
  });
}
