export type ThreadwireErrorCode =
  | "CONFIG_INVALID"
  | "PROCESS_INSPECTION_FAILED"
  | "CLASSIC_PROCESS_TOPOLOGY_INVALID"
  | "CLASSIC_INSTALLATION_NOT_FOUND"
  | "CLASSIC_INSTALLATION_QUERY_FAILED"
  | "CLASSIC_START_FAILED"
  | "CLASSIC_STOP_FAILED"
  | "PROCESS_EXIT_TIMEOUT"
  | "NEW_PROCESS_NOT_OBSERVED"
  | "RUNTIME_NOT_OBSERVED"
  | "CDP_ENDPOINT_UNAVAILABLE"
  | "CDP_ENDPOINT_TIMEOUT"
  | "CDP_TARGET_LIST_MALFORMED"
  | "CDP_TARGET_NOT_FOUND"
  | "CDP_TARGET_AMBIGUOUS"
  | "CDP_ATTACH_FAILED"
  | "CDP_DISCONNECTED"
  | "CDP_NAVIGATION_FAILED"
  | "CDP_READINESS_FAILED"
  | "RUNTIME_GENERATION_CHANGED"
  | "OPERATION_TIMEOUT"
  | "OPERATION_ABORTED"
  | "CONVERSATION_LOCATOR_INVALID"
  | "THREAD_NOT_FOUND"
  | "THREAD_HANDLE_COLLISION"
  | "PROJECT_LOCATOR_INVALID"
  | "PROJECT_HANDLE_COLLISION"
  | "PROJECT_CREATION_FAILED"
  | "ROUTE_NAVIGATION_FAILED"
  | "EXISTING_ROUTE_READINESS_TIMEOUT"
  | "FRESH_ROUTE_READINESS_TIMEOUT"
  | "TURN_INPUT_FAILED"
  | "TURN_WRITE_FAILED"
  | "FRESH_CONVERSATION_NOT_CREATED"
  | "TURN_STATE_UNCERTAIN"
  | "RESPONSE_STREAM_UNAVAILABLE"
  | "RESPONSE_STREAM_FAILED"
  | "RESPONSE_PARSE_FAILED";

export class ThreadwireError extends Error {
  public readonly code: ThreadwireErrorCode;

  constructor(message: string, code: ThreadwireErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "ThreadwireError";
    this.code = code;
  }
}

export class InvalidConfigurationError extends ThreadwireError {
  constructor(message: string = "Invalid Threadwire controller configuration.", options?: ErrorOptions) {
    super(message, "CONFIG_INVALID", options);
    this.name = "InvalidConfigurationError";
  }
}

export class ProcessInspectionFailedError extends ThreadwireError {
  constructor(message: string = "Failed to inspect ChatGPT Classic processes.", options?: ErrorOptions) {
    super(message, "PROCESS_INSPECTION_FAILED", options);
    this.name = "ProcessInspectionFailedError";
  }
}

export class ClassicProcessTopologyError extends ThreadwireError {
  constructor(message: string = "ChatGPT Classic process topology is not uniquely classifiable.", options?: ErrorOptions) {
    super(message, "CLASSIC_PROCESS_TOPOLOGY_INVALID", options);
    this.name = "ClassicProcessTopologyError";
  }
}

export class ClassicInstallationNotFoundError extends ThreadwireError {
  constructor(message: string = "ChatGPT Classic installation not found.", options?: ErrorOptions) {
    super(message, "CLASSIC_INSTALLATION_NOT_FOUND", options);
    this.name = "ClassicInstallationNotFoundError";
  }
}

export class ClassicInstallationQueryFailedError extends ThreadwireError {
  constructor(message: string = "Failed to query the ChatGPT Classic installation.", options?: ErrorOptions) {
    super(message, "CLASSIC_INSTALLATION_QUERY_FAILED", options);
    this.name = "ClassicInstallationQueryFailedError";
  }
}

export class ClassicStartFailedError extends ThreadwireError {
  constructor(message: string = "Failed to start ChatGPT Classic.", options?: ErrorOptions) {
    super(message, "CLASSIC_START_FAILED", options);
    this.name = "ClassicStartFailedError";
  }
}

export class ClassicStopFailedError extends ThreadwireError {
  constructor(message: string = "Failed to stop ChatGPT Classic.", options?: ErrorOptions) {
    super(message, "CLASSIC_STOP_FAILED", options);
    this.name = "ClassicStopFailedError";
  }
}

export class ProcessExitTimeoutError extends ThreadwireError {
  constructor(message: string = "Timed out waiting for the previous Classic process generation to exit.", options?: ErrorOptions) {
    super(message, "PROCESS_EXIT_TIMEOUT", options);
    this.name = "ProcessExitTimeoutError";
  }
}

export class NewProcessNotObservedError extends ThreadwireError {
  constructor(message: string = "A new ChatGPT Classic Main process was not observed after launch.", options?: ErrorOptions) {
    super(message, "NEW_PROCESS_NOT_OBSERVED", options);
    this.name = "NewProcessNotObservedError";
  }
}

export class RuntimeNotObservedError extends ThreadwireError {
  constructor(message: string = "No current ChatGPT Classic runtime has been observed.", options?: ErrorOptions) {
    super(message, "RUNTIME_NOT_OBSERVED", options);
    this.name = "RuntimeNotObservedError";
  }
}

export class CdpEndpointUnavailableError extends ThreadwireError {
  constructor(message: string = "The CDP localhost endpoint is unavailable.", options?: ErrorOptions) {
    super(message, "CDP_ENDPOINT_UNAVAILABLE", options);
    this.name = "CdpEndpointUnavailableError";
  }
}

export class CdpEndpointTimeoutError extends ThreadwireError {
  constructor(message: string = "Timed out waiting for the CDP localhost endpoint.", options?: ErrorOptions) {
    super(message, "CDP_ENDPOINT_TIMEOUT", options);
    this.name = "CdpEndpointTimeoutError";
  }
}

export class CdpTargetListMalformedError extends ThreadwireError {
  constructor(message: string = "The CDP target list is malformed.", options?: ErrorOptions) {
    super(message, "CDP_TARGET_LIST_MALFORMED", options);
    this.name = "CdpTargetListMalformedError";
  }
}

export class CdpTargetNotFoundError extends ThreadwireError {
  constructor(message: string = "No eligible ChatGPT page target was found.", options?: ErrorOptions) {
    super(message, "CDP_TARGET_NOT_FOUND", options);
    this.name = "CdpTargetNotFoundError";
  }
}

export class CdpTargetAmbiguousError extends ThreadwireError {
  constructor(message: string = "Multiple eligible ChatGPT page targets were found.", options?: ErrorOptions) {
    super(message, "CDP_TARGET_AMBIGUOUS", options);
    this.name = "CdpTargetAmbiguousError";
  }
}

export class CdpAttachFailedError extends ThreadwireError {
  constructor(message: string = "Failed to attach to the selected CDP target.", options?: ErrorOptions) {
    super(message, "CDP_ATTACH_FAILED", options);
    this.name = "CdpAttachFailedError";
  }
}

export class CdpDisconnectedError extends ThreadwireError {
  constructor(message: string = "The CDP session is disconnected.", options?: ErrorOptions) {
    super(message, "CDP_DISCONNECTED", options);
    this.name = "CdpDisconnectedError";
  }
}

export class CdpNavigationFailedError extends ThreadwireError {
  constructor(message: string = "CDP navigation command failed.", options?: ErrorOptions) {
    super(message, "CDP_NAVIGATION_FAILED", options);
    this.name = "CdpNavigationFailedError";
  }
}

export class CdpReadinessFailedError extends ThreadwireError {
  constructor(message: string = "CDP readiness observation failed.", options?: ErrorOptions) {
    super(message, "CDP_READINESS_FAILED", options);
    this.name = "CdpReadinessFailedError";
  }
}

export class RuntimeGenerationChangedError extends ThreadwireError {
  constructor(message: string = "The ChatGPT Classic runtime generation changed during the operation.", options?: ErrorOptions) {
    super(message, "RUNTIME_GENERATION_CHANGED", options);
    this.name = "RuntimeGenerationChangedError";
  }
}

export class OperationTimeoutError extends ThreadwireError {
  constructor(message: string = "Operation timed out.", options?: ErrorOptions) {
    super(message, "OPERATION_TIMEOUT", options);
    this.name = "OperationTimeoutError";
  }
}

export class OperationAbortedError extends ThreadwireError {
  constructor(message: string = "Operation aborted.", options?: ErrorOptions) {
    super(message, "OPERATION_ABORTED", options);
    this.name = "OperationAbortedError";
  }
}

export class ConversationLocatorInvalidError extends ThreadwireError {
  constructor(message: string = "Conversation locator is invalid for the Threadwire MVP route contract.", options?: ErrorOptions) {
    super(message, "CONVERSATION_LOCATOR_INVALID", options);
    this.name = "ConversationLocatorInvalidError";
  }
}

export class ThreadNotFoundError extends ThreadwireError {
  constructor(message: string = "Thread handle is not known to Threadwire.", options?: ErrorOptions) {
    super(message, "THREAD_NOT_FOUND", options);
    this.name = "ThreadNotFoundError";
  }
}

export class ThreadHandleCollisionError extends ThreadwireError {
  constructor(message: string = "Unable to allocate a unique Threadwire thread handle.", options?: ErrorOptions) {
    super(message, "THREAD_HANDLE_COLLISION", options);
    this.name = "ThreadHandleCollisionError";
  }
}

export class ProjectLocatorInvalidError extends ThreadwireError {
  constructor(message: string = "Project locator is invalid for the Threadwire route contract.", options?: ErrorOptions) {
    super(message, "PROJECT_LOCATOR_INVALID", options);
    this.name = "ProjectLocatorInvalidError";
  }
}

export class ProjectHandleCollisionError extends ThreadwireError {
  constructor(message: string = "Unable to allocate a unique Threadwire project handle.", options?: ErrorOptions) {
    super(message, "PROJECT_HANDLE_COLLISION", options);
    this.name = "ProjectHandleCollisionError";
  }
}

export class ProjectCreationFailedError extends ThreadwireError {
  constructor(message: string = "ChatGPT Project creation could not be completed safely.", options?: ErrorOptions) {
    super(message, "PROJECT_CREATION_FAILED", options);
    this.name = "ProjectCreationFailedError";
  }
}

export class RouteNavigationFailedError extends ThreadwireError {
  constructor(message: string = "Threadwire route navigation failed.", options?: ErrorOptions) {
    super(message, "ROUTE_NAVIGATION_FAILED", options);
    this.name = "RouteNavigationFailedError";
  }
}

export class ExistingRouteReadinessTimeoutError extends ThreadwireError {
  constructor(message: string = "Existing conversation route did not become ready before the deadline.", options?: ErrorOptions) {
    super(message, "EXISTING_ROUTE_READINESS_TIMEOUT", options);
    this.name = "ExistingRouteReadinessTimeoutError";
  }
}

export class FreshRouteReadinessTimeoutError extends ThreadwireError {
  constructor(message: string = "Fresh conversation route did not become ready before the deadline.", options?: ErrorOptions) {
    super(message, "FRESH_ROUTE_READINESS_TIMEOUT", options);
    this.name = "FreshRouteReadinessTimeoutError";
  }
}

export class TurnInputFailedError extends ThreadwireError {
  constructor(message: string = "Turn input could not be submitted safely.", options?: ErrorOptions) {
    super(message, "TURN_INPUT_FAILED", options);
    this.name = "TurnInputFailedError";
  }
}

export class TurnWriteFailedError extends ThreadwireError {
  constructor(message: string = "The legitimate conversation write failed before safe completion.", options?: ErrorOptions) {
    super(message, "TURN_WRITE_FAILED", options);
    this.name = "TurnWriteFailedError";
  }
}

export class FreshConversationNotCreatedError extends ThreadwireError {
  constructor(message: string = "The fresh turn did not establish a supported conversation route.", options?: ErrorOptions) {
    super(message, "FRESH_CONVERSATION_NOT_CREATED", options);
    this.name = "FreshConversationNotCreatedError";
  }
}

export class TurnStateUncertainError extends ThreadwireError {
  constructor(message: string = "Turn state is uncertain; mutating operations are blocked until the runtime generation changes.", options?: ErrorOptions) {
    super(message, "TURN_STATE_UNCERTAIN", options);
    this.name = "TurnStateUncertainError";
  }
}

export class ResponseStreamUnavailableError extends ThreadwireError {
  constructor(message: string = "Response streaming is unavailable for the selected legitimate conversation write.", options?: ErrorOptions) {
    super(message, "RESPONSE_STREAM_UNAVAILABLE", options);
    this.name = "ResponseStreamUnavailableError";
  }
}

export class ResponseStreamFailedError extends ThreadwireError {
  constructor(message: string = "The legitimate conversation response stream could not be consumed safely.", options?: ErrorOptions) {
    super(message, "RESPONSE_STREAM_FAILED", options);
    this.name = "ResponseStreamFailedError";
  }
}

export class ResponseParseFailedError extends ThreadwireError {
  constructor(message: string = "The legitimate conversation response stream could not be normalized safely.", options?: ErrorOptions) {
    super(message, "RESPONSE_PARSE_FAILED", options);
    this.name = "ResponseParseFailedError";
  }
}
