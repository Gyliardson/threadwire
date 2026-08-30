import { ThreadwireError, ThreadwireErrorCode } from "../domain/errors.js";
import { ControllerBusyError } from "../controller/ControllerTurnQueue.js";

export type ApiBoundaryErrorCode =
  | ThreadwireErrorCode
  | "CONTROLLER_BUSY"
  | "API_REQUEST_INVALID"
  | "API_REQUEST_TOO_LARGE"
  | "API_REQUEST_REJECTED"
  | "INTERNAL_ERROR";

export interface PublicApiError {
  readonly error: Readonly<{
    code: ApiBoundaryErrorCode;
    message: string;
    retryable: boolean;
  }>;
}

export class ApiRequestError extends Error {
  public constructor(
    public readonly code: Extract<
      ApiBoundaryErrorCode,
      "API_REQUEST_INVALID" | "API_REQUEST_TOO_LARGE" | "API_REQUEST_REJECTED"
    >,
    public readonly statusCode: number,
  ) {
    super(code);
    this.name = "ApiRequestError";
  }
}

function apiMessage(code: ApiBoundaryErrorCode): string {
  switch (code) {
    case "API_REQUEST_INVALID":
      return "Invalid Threadwire API request.";
    case "API_REQUEST_TOO_LARGE":
      return "Threadwire API request exceeds the configured engineering limit.";
    case "API_REQUEST_REJECTED":
      return "Threadwire API request was rejected by the localhost boundary.";
    case "CONTROLLER_BUSY":
      return "Threadwire controller capacity is full.";
    case "INTERNAL_ERROR":
      return "Threadwire encountered an internal error.";
    default:
      return "Threadwire operation failed.";
  }
}

export function serializePublicError(error: unknown): PublicApiError {
  let code: ApiBoundaryErrorCode = "INTERNAL_ERROR";
  if (error instanceof ApiRequestError) {
    code = error.code;
  } else if (error instanceof ControllerBusyError) {
    code = "CONTROLLER_BUSY";
  } else if (error instanceof ThreadwireError) {
    code = error.code;
  }

  return Object.freeze({
    error: Object.freeze({
      code,
      message: apiMessage(code),
      retryable: code === "CONTROLLER_BUSY",
    }),
  });
}
