import { ControllerConfig } from "../config/ControllerConfig.js";
import { InvalidConfigurationError } from "../domain/errors.js";

export interface ThreadwireApiConfig {
  readonly apiHost: "127.0.0.1";
  readonly apiPort: number;
}

function parseTcpPort(value: string, variableName: string): number {
  if (!/^[1-9]\d{0,4}$/.test(value)) {
    throw new InvalidConfigurationError(
      `${variableName} must be a decimal TCP port between 1 and 65535.`,
    );
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new InvalidConfigurationError(
      `${variableName} must be a decimal TCP port between 1 and 65535.`,
    );
  }
  return port;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ThreadwireApiConfig {
  const apiHost = env.THREADWIRE_API_HOST ?? "127.0.0.1";
  const apiPortText = env.THREADWIRE_API_PORT ?? "9224";

  if (apiHost !== "127.0.0.1") {
    throw new InvalidConfigurationError("THREADWIRE_API_HOST must be exactly 127.0.0.1.");
  }

  return {
    apiHost,
    apiPort: parseTcpPort(apiPortText, "THREADWIRE_API_PORT"),
  };
}

export function assertApiConfigCompatible(
  apiConfig: ThreadwireApiConfig,
  controllerConfig: ControllerConfig,
): void {
  if (apiConfig.apiPort === controllerConfig.cdpPort) {
    throw new InvalidConfigurationError(
      "THREADWIRE_API_PORT must differ from THREADWIRE_CDP_PORT.",
    );
  }
}
