import { ControllerConfig } from "../config/ControllerConfig.js";
import { RuntimeProvenanceUnverifiedError } from "../domain/errors.js";
import { CdpTargetInfo } from "./types.js";

export function assertTargetDebuggerEndpoint(
  target: CdpTargetInfo,
  config: ControllerConfig,
): void {
  const rawUrl = target.webSocketDebuggerUrl;
  if (!rawUrl) {
    throw new RuntimeProvenanceUnverifiedError();
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new RuntimeProvenanceUnverifiedError(undefined, { cause: error });
  }

  if (
    url.protocol !== "ws:" ||
    url.hostname !== config.cdpHost ||
    url.port !== String(config.cdpPort) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new RuntimeProvenanceUnverifiedError();
  }
}
