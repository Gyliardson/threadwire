import { InvalidConfigurationError } from "../domain/errors.js";

export type ClassicPolicy = "MANAGED" | "BOUND_EXISTING";

export interface ControllerConfig {
  readonly cdpHost: "127.0.0.1";
  readonly cdpPort: number;
  readonly classicPolicy?: ClassicPolicy;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControllerConfig {
  const cdpHost = env.THREADWIRE_CDP_HOST ?? "127.0.0.1";
  const cdpPortText = env.THREADWIRE_CDP_PORT ?? "9223";
  const classicPolicyText = env.THREADWIRE_CLASSIC_POLICY ?? "MANAGED";

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

  if (classicPolicyText !== "MANAGED" && classicPolicyText !== "BOUND_EXISTING") {
    throw new InvalidConfigurationError(
      "THREADWIRE_CLASSIC_POLICY must be exactly MANAGED or BOUND_EXISTING.",
    );
  }

  return { cdpHost, cdpPort, classicPolicy: classicPolicyText };
}
