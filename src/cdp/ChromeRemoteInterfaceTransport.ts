import CDP from "chrome-remote-interface";
import { OperationAbortedError } from "../domain/errors.js";
import { CdpTransport, CdpTransportConnectOptions, CdpTransportSession } from "./CdpTransport.js";
import { isCriClient } from "./ChromeRemoteInterfaceHelpers.js";
import { ChromeRemoteInterfaceSession } from "./ChromeRemoteInterfaceSession.js";
import { MutationGuardedChromeRemoteInterfaceSession } from "./MutationGuardedChromeRemoteInterfaceSession.js";

export type CriClient = Awaited<ReturnType<typeof CDP>>;

export interface ChromeRemoteInterfaceTransportOptions {
  readonly connect?: (options: Readonly<{ host: string; port: number; target: string }>) => Promise<unknown>;
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

function createSession(
  client: CriClient,
  options: CdpTransportConnectOptions,
): CdpTransportSession {
  return options.beforeMutation
    ? new MutationGuardedChromeRemoteInterfaceSession(client, options.beforeMutation)
    : new ChromeRemoteInterfaceSession(client);
}

export class ChromeRemoteInterfaceTransport implements CdpTransport {
  private readonly connectClient: NonNullable<ChromeRemoteInterfaceTransportOptions["connect"]>;

  public constructor(options: ChromeRemoteInterfaceTransportOptions = {}) {
    this.connectClient = options.connect ?? (async (connectOptions) => await CDP(connectOptions));
  }

  public async connect(options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    const webSocketDebuggerUrl = options.target.webSocketDebuggerUrl;
    if (!webSocketDebuggerUrl) {
      throw new TypeError("Selected target has no WebSocket debugger URL.");
    }

    const clientPromise = this.connectClient({
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
      return createSession(client, options);
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
          resolve(createSession(client, options));
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
