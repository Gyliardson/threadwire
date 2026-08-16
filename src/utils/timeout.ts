import { OperationAbortedError, OperationTimeoutError } from "../domain/errors.js";

export interface TimeoutOptions {
  readonly signal?: AbortSignal;
  readonly message?: string;
}

function abortedError(signal: AbortSignal): Error {
  if (signal.reason instanceof OperationTimeoutError || signal.reason instanceof OperationAbortedError) {
    return signal.reason;
  }
  return new OperationAbortedError(undefined, signal.reason === undefined ? undefined : { cause: signal.reason });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortedError(signal);
  }
}

export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError("Delay must be a non-negative finite number.");
  }

  throwIfAborted(signal);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);

    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(abortedError(signal!));
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  options: TimeoutOptions = {},
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Timeout must be a positive finite number.");
  }

  throwIfAborted(options.signal);

  const controller = new AbortController();
  const timeoutError = new OperationTimeoutError(options.message);
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);

  const onParentAbort = (): void => {
    const parent = options.signal;
    controller.abort(
      new OperationAbortedError(undefined, parent?.reason === undefined ? undefined : { cause: parent.reason }),
    );
  };

  if (options.signal) {
    options.signal.addEventListener("abort", onParentAbort, { once: true });
  }

  const abortPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(abortedError(controller.signal)),
      { once: true },
    );
  });

  try {
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    return await Promise.race([operationPromise, abortPromise]);
  } finally {
    clearTimeout(timer);
    if (options.signal) {
      options.signal.removeEventListener("abort", onParentAbort);
    }
  }
}
