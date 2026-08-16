import { RuntimeLease, RuntimeLeaseSource } from "../domain/RuntimeGeneration.js";
import { OperationAbortedError } from "../domain/errors.js";
import { throwIfAborted } from "../utils/timeout.js";

export type MutationOperationKind = "ROUTE" | "TURN";
export type MutationOperation<T> = (
  signal: AbortSignal | undefined,
  lease: RuntimeLease,
) => Promise<T> | T;

export interface ScheduleOperationOptions {
  readonly signal?: AbortSignal;
}

interface QueueEntry {
  readonly kind: MutationOperationKind;
  readonly lease: RuntimeLease;
  readonly run: () => Promise<void>;
  settled: boolean;
  started: boolean;
}

export class OperationScheduler {
  private readonly queue: QueueEntry[] = [];
  private running = false;

  public constructor(private readonly runtime: RuntimeLeaseSource) {}

  public schedule<T>(
    kind: MutationOperationKind,
    operation: MutationOperation<T>,
    options: ScheduleOperationOptions = {},
  ): Promise<T> {
    try {
      throwIfAborted(options.signal);
    } catch (error) {
      return Promise.reject(error);
    }

    let lease: RuntimeLease;
    try {
      lease = this.runtime.getCurrentRuntimeLease();
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        kind,
        lease,
        settled: false,
        started: false,
        run: async () => {
          if (entry.settled) {
            return;
          }
          entry.started = true;
          if (options.signal) {
            options.signal.removeEventListener("abort", onQueuedAbort);
          }

          try {
            throwIfAborted(options.signal);
            this.runtime.assertRuntimeLeaseCurrent(entry.lease);
            const result = await operation(options.signal, entry.lease);
            entry.settled = true;
            resolve(result);
          } catch (error) {
            entry.settled = true;
            reject(error);
          }
        },
      };

      const onQueuedAbort = (): void => {
        if (entry.started || entry.settled) {
          return;
        }
        entry.settled = true;
        reject(
          new OperationAbortedError(
            undefined,
            options.signal?.reason === undefined ? undefined : { cause: options.signal.reason },
          ),
        );
      };

      if (options.signal) {
        options.signal.addEventListener("abort", onQueuedAbort, { once: true });
      }
      this.queue.push(entry);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift();
        if (!entry || entry.settled) {
          continue;
        }
        await entry.run();
      }
    } finally {
      this.running = false;
      if (this.queue.length > 0) {
        void this.drain();
      }
    }
  }
}
