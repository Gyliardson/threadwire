import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { InvalidConfigurationError } from "../domain/errors.js";

export interface ControllerConfig {
  readonly cdpHost: "127.0.0.1";
  readonly cdpPort: number;
  readonly statePath?: string;
}

export function defaultThreadwireStatePath(): string {
  return join(homedir(), ".threadwire", "state.sqlite3");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControllerConfig {
  const cdpHost = env.THREADWIRE_CDP_HOST ?? "127.0.0.1";
  const cdpPortText = env.THREADWIRE_CDP_PORT ?? "9223";
  const statePath = env.THREADWIRE_STATE_PATH ?? defaultThreadwireStatePath();

  if (cdpHost !== "127.0.0.1") {
    throw new InvalidConfigurationError("THREADWIRE_CDP_HOST must be exactly 127.0.0.1.");
  }

  if (!/^[1-9]\d{0,4}$/.test(cdpPortText)) {
    throw new InvalidConfigurationError("THREADWIRE_CDP_PORT must be a decimal TCP port between 1 and 65535.");
  }

  const cdpPort = Number(cdpPortText);
  if (!Number.isSafeInteger(cdpPort) || cdpPort > 65535) {
    throw new InvalidConfigurationError("THREADWIRE_CDP_PORT must be a decimal TCP port between 1 and 65535.");
  }

  if (statePath.length === 0 || statePath.includes("\0") || !isAbsolute(statePath)) {
    throw new InvalidConfigurationError("THREADWIRE_STATE_PATH must be an absolute filesystem path.");
  }

  return { cdpHost, cdpPort, statePath };
}
