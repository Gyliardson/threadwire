export class ThreadwireError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ThreadwireError";
    this.code = code;
  }
}

export class ClassicInstallationNotFoundError extends ThreadwireError {
  constructor(message: string = "ChatGPT Classic installation not found.") {
    super(message, "CLASSIC_INSTALLATION_NOT_FOUND");
    this.name = "ClassicInstallationNotFoundError";
  }
}

export class ClassicStartFailedError extends ThreadwireError {
  constructor(message: string = "Failed to start ChatGPT Classic.") {
    super(message, "CLASSIC_START_FAILED");
    this.name = "ClassicStartFailedError";
  }
}

export class ClassicStopFailedError extends ThreadwireError {
  constructor(message: string = "Failed to stop ChatGPT Classic.") {
    super(message, "CLASSIC_STOP_FAILED");
    this.name = "ClassicStopFailedError";
  }
}

export class ProcessExitTimeoutError extends ThreadwireError {
  constructor(message: string = "Timeout waiting for process to exit.") {
    super(message, "PROCESS_EXIT_TIMEOUT");
    this.name = "ProcessExitTimeoutError";
  }
}

export class NewProcessNotObservedError extends ThreadwireError {
  constructor(message: string = "New Classic main process was not observed after launch.") {
    super(message, "NEW_PROCESS_NOT_OBSERVED");
    this.name = "NewProcessNotObservedError";
  }
}

export class CdpEndpointTimeoutError extends ThreadwireError {
  constructor(message: string = "Timeout waiting for CDP localhost endpoint.") {
    super(message, "CDP_ENDPOINT_TIMEOUT");
    this.name = "CdpEndpointTimeoutError";
  }
}

export class CdpTargetNotFoundError extends ThreadwireError {
  constructor(message: string = "ChatGPT page target not found.") {
    super(message, "CDP_TARGET_NOT_FOUND");
    this.name = "CdpTargetNotFoundError";
  }
}

export class CdpAttachFailedError extends ThreadwireError {
  constructor(message: string = "Failed to attach to CDP target.") {
    super(message, "CDP_ATTACH_FAILED");
    this.name = "CdpAttachFailedError";
  }
}

export class CdpDisconnectedError extends ThreadwireError {
  constructor(message: string = "CDP session disconnected.") {
    super(message, "CDP_DISCONNECTED");
    this.name = "CdpDisconnectedError";
  }
}

export class RuntimeGenerationChangedError extends ThreadwireError {
  constructor(message: string = "Runtime generation changed during operation.") {
    super(message, "RUNTIME_GENERATION_CHANGED");
    this.name = "RuntimeGenerationChangedError";
  }
}
