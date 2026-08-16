import CDP from "chrome-remote-interface";
import { OperationAbortedError } from "../domain/errors.js";
import { CdpTransport, CdpTransportConnectOptions, CdpTransportSession } from "./CdpTransport.js";

interface CriClientLike {
  close(): Promise<void>;
  on(event: "disconnect", listener: () => void): unknown;
  removeListener(event: "disconnect", listener: () => void): unknown;
}

interface CriConnectOptions {
  readonly host: string;
  readonly port: number;
  readonly target: string;
}

type CriConnect = (options: CriConnectOptions) => Promise<unknown>;
const connectCri = CDP as unknown as CriConnect;

function isCriClient(value: unknown): value is CriClientLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<CriClientLike>;
  return (
    typeof candidate.close === "function" &&
    typeof candidate.on === "function" &&
    typeof candidate.removeListener === "function"
  );
}

class ChromeRemoteInterfaceSession implements CdpTransportSession {
  public constructor(private readonly client: CriClientLike) {}

  public async close(): Promise<void> {
    await this.client.close();
  }

  public onDisconnect(listener: () => void): () => void {
    this.client.on("disconnect", listener);
    return () => {
      this.client.removeListener("disconnect", listener);
    };
  }
}

async function closeLateClient(promise: Promise<unknown>): Promise<void> {
  try {
    const late = await promise;
    if (isCriClient(late)) {
      await late.close();
    }
  } catch {
    // The caller already observed the failed/aborted attach.
  }
}

export class ChromeRemoteInterfaceTransport implements CdpTransport {
  public async connect(options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    const webSocketDebuggerUrl = options.target.webSocketDebuggerUrl;
    if (!webSocketDebuggerUrl) {
      throw new TypeError("Selected target has no WebSocket debugger URL.");
    }

    const clientPromise = connectCri({
      host: options.host,
      port: options.port,
      target: webSocketDebuggerUrl,
    });

    const signal = options.signal;
    if (!signal) {
      const client = await clientPromise;
      if (!isCriClient(client)) {
        throw new TypeError("chrome-remote-interface returned an invalid client.");
      }
      return new ChromeRemoteInterfaceSession(client);
    }

    if (signal.aborted) {
      void closeLateClient(clientPromise);
      throw new OperationAbortedError();
    }

    return await new Promise<CdpTransportSession>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        void closeLateClient(clientPromise);
        reject(
          new OperationAbortedError(
            undefined,
            signal.reason === undefined ? undefined : { cause: signal.reason },
          ),
        );
      };

      signal.addEventListener("abort", onAbort, { once: true });
      clientPromise.then(
        (client) => {
          if (settled) {
            return;
          }
          settled = true;
          signal.removeEventListener("abort", onAbort);
          if (!isCriClient(client)) {
            reject(new TypeError("chrome-remote-interface returned an invalid client."));
            return;
          }
          resolve(new ChromeRemoteInterfaceSession(client));
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }
}
