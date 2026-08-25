import { OperationAbortedError } from "../domain/errors.js";

export const DEFAULT_CONTROLLER_MAX_OUTSTANDING_TURNS = 8;

export class ControllerBusyError extends Error {
  public readonly code = "CONTROLLER_BUSY" as const;

  public constructor() {
    super("Threadwire controller turn capacity is full.");
    this.name = "ControllerBusyError";
  }
}

interface PendingTurn<T = unknown> {
  readonly operation: () => Promise<T>;
  readonly signal?: AbortSignal;
  readonly resolve: (result: T) => void;
  readonly reject: (error: unknown) => void;
  started: boolean;
  onAbort: (() => void) | null;
}

export class ControllerTurnQueue {
  private readonly pending: PendingTurn<unknown>[] = [];
  private active = false;

  public constructor(
    private readonly maxOutstandingTurns: number = DEFAULT_CONTROLLER_MAX_OUTSTANDING_TURNS,
  ) {
    if (!Number.isSafeInteger(maxOutstandingTurns) || maxOutstandingTurns <= 0) {
      throw new RangeError("maxOutstandingTurns must be a positive safe integer.");
    }
  }

  public schedule<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.pending.length + (this.active ? 1 : 0) >= this.maxOutstandingTurns) {
      throw new ControllerBusyError();
    }
    if (signal?.aborted) {
      return Promise.reject(new OperationAbortedError());
    }

    return new Promise<T>((resolve, reject) => {
      const entry: PendingTurn<T> = {
        operation,
        ...(signal ? { signal } : {}),
        resolve,
        reject,
        started: false,
        onAbort: null,
      };

      if (signal) {
        entry.onAbort = () => {
          if (entry.started) {
            return;
          }
          const index = this.pending.indexOf(entry as PendingTurn<unknown>);
          if (index >= 0) {
            this.pending.splice(index, 1);
          }
          signal.removeEventListener("abort", entry.onAbort!);
          entry.onAbort = null;
          reject(new OperationAbortedError());
          this.drain();
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }

      this.pending.push(entry as PendingTurn<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    if (this.active) {
      return;
    }
    const entry = this.pending.shift();
    if (entry === undefined) {
      return;
    }

    entry.started = true;
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener("abort", entry.onAbort);
      entry.onAbort = null;
    }
    if (entry.signal?.aborted) {
      entry.reject(new OperationAbortedError());
      queueMicrotask(() => this.drain());
      return;
    }

    this.active = true;
    void Promise.resolve()
      .then(entry.operation)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.active = false;
        this.drain();
      });
  }
}
