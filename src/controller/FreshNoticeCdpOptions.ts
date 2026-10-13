import type { CdpSessionManagerOptions } from "../cdp/CdpSessionManager.js";
import { ControllerConfig } from "../config/ControllerConfig.js";
import { InvalidConfigurationError } from "../domain/errors.js";
import { FreshNoticeBudget } from "../readiness/FreshNoticeBudget.js";
import type { OperationScheduler } from "../routing/OperationScheduler.js";

// Both actual production factories must bind notice authority to the scheduler
// that owns their route and turn mutations. Diagnostic selection cannot omit it.
export function createFreshNoticeCdpOptions(
  config: ControllerConfig,
  scheduler: OperationScheduler,
): CdpSessionManagerOptions {
  if (config.knownFreshNoticeIntent === undefined) return {};
  if (config.classicPolicy !== "BOUND_EXISTING") {
    throw new InvalidConfigurationError(
      "Known FRESH notice authority requires BOUND_EXISTING.",
    );
  }
  return {
    freshNoticeBudget: new FreshNoticeBudget(config.knownFreshNoticeIntent),
    onReadinessMutationUncertain: (lease) =>
      scheduler.markRuntimeMutationStateUncertain(lease),
  };
}
