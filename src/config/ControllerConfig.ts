export interface ControllerConfig {
  cdpHost: string;
  cdpPort: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControllerConfig {
  const cdpHost = env.THREADWIRE_CDP_HOST || "127.0.0.1";
  const cdpPortStr = env.THREADWIRE_CDP_PORT || "9223";

  if (cdpHost !== "127.0.0.1") {
    throw new Error("Security Violation: THREADWIRE_CDP_HOST must be 127.0.0.1");
  }

  const cdpPort = parseInt(cdpPortStr, 10);
  if (isNaN(cdpPort) || cdpPort <= 0 || cdpPort > 65535) {
    throw new Error(`Invalid THREADWIRE_CDP_PORT: ${cdpPortStr}`);
  }

  return {
    cdpHost,
    cdpPort,
  };
}
