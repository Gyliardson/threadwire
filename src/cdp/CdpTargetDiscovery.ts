import http from "node:http";
import { ControllerConfig } from "../config/ControllerConfig.js";
import {
  CdpEndpointTimeoutError,
  CdpEndpointUnavailableError,
  CdpTargetAmbiguousError,
  CdpTargetListMalformedError,
  CdpTargetNotFoundError,
  OperationAbortedError,
  OperationTimeoutError,
  ThreadwireError,
} from "../domain/errors.js";
import { delay, withTimeout } from "../utils/timeout.js";
import { CdpTargetInfo, CdpTargetList } from "./types.js";

const DEFAULT_DISCOVERY_TIMEOUT_MS = 10000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_TARGET_LIST_BYTES = 1024 * 1024;

export interface CdpTargetListClient {
  requestTargetList(signal?: AbortSignal): Promise<string>;
}

class NodeCdpTargetListClient implements CdpTargetListClient {
  public constructor(private readonly config: ControllerConfig) {}

  public async requestTargetList(signal?: AbortSignal): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const request = http.get(
        {
          host: this.config.cdpHost,
          port: this.config.cdpPort,
          path: "/json/list",
          ...(signal ? { signal } : {}),
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(new CdpEndpointUnavailableError());
            return;
          }

          let size = 0;
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.byteLength;
            if (size > MAX_TARGET_LIST_BYTES) {
              request.destroy(new CdpTargetListMalformedError());
              return;
            }
            chunks.push(buffer);
          });
          response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      );

      request.setTimeout(DEFAULT_REQUEST_TIMEOUT_MS, () => {
        request.destroy(new CdpEndpointUnavailableError());
      });
      request.on("error", (error) => {
        if (signal?.aborted) {
          reject(new OperationAbortedError(undefined, signal.reason === undefined ? { cause: error } : { cause: signal.reason }));
          return;
        }
        if (error instanceof ThreadwireError) {
          reject(error);
          return;
        }
        reject(new CdpEndpointUnavailableError(undefined, { cause: error }));
      });
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTarget(value: unknown): CdpTargetInfo {
  if (!isRecord(value)) {
    throw new CdpTargetListMalformedError();
  }

  const { id, title, type, description, webSocketDebuggerUrl, url } = value;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof type !== "string" ||
    type.length === 0 ||
    typeof url !== "string" ||
    (title !== undefined && typeof title !== "string") ||
    (description !== undefined && typeof description !== "string") ||
    (webSocketDebuggerUrl !== undefined && typeof webSocketDebuggerUrl !== "string")
  ) {
    throw new CdpTargetListMalformedError();
  }

  return {
    id,
    title: title ?? "",
    type,
    description: description ?? "",
    webSocketDebuggerUrl: webSocketDebuggerUrl ?? null,
    url,
  };
}

export function parseCdpTargetList(body: string): CdpTargetList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new CdpTargetListMalformedError(undefined, { cause: error });
  }

  if (!Array.isArray(parsed)) {
    throw new CdpTargetListMalformedError();
  }
  return parsed.map(parseTarget);
}

function parseTargetUrl(target: CdpTargetInfo): URL | null {
  try {
    return new URL(target.url);
  } catch {
    return null;
  }
}

export function selectPrimaryChatGptTarget(targets: CdpTargetList): CdpTargetInfo {
  const eligible: CdpTargetInfo[] = [];
  for (const target of targets) {
    if (target.type !== "page") {
      continue;
    }
    const parsedUrl = parseTargetUrl(target);
    if (parsedUrl === null) {
      throw new CdpTargetListMalformedError();
    }
    if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "chatgpt.com") {
      continue;
    }
    if (!target.webSocketDebuggerUrl) {
      throw new CdpTargetListMalformedError();
    }
    eligible.push(target);
  }

  if (eligible.length === 0) {
    throw new CdpTargetNotFoundError();
  }
  if (eligible.length > 1) {
    throw new CdpTargetAmbiguousError();
  }
  return eligible[0]!;
}

export interface FindPrimaryTargetOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export class CdpTargetDiscovery {
  private readonly client: CdpTargetListClient;

  public constructor(
    config: ControllerConfig,
    client?: CdpTargetListClient,
  ) {
    this.client = client ?? new NodeCdpTargetListClient(config);
  }

  public async getTargets(signal?: AbortSignal): Promise<CdpTargetList> {
    return parseCdpTargetList(await this.client.requestTargetList(signal));
  }

  public async findPrimaryTarget(options: FindPrimaryTargetOptions = {}): Promise<CdpTargetInfo> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    let sawValidTargetList = false;

    try {
      return await withTimeout(
        async (waitSignal) => {
          while (true) {
            try {
              const targets = await this.getTargets(waitSignal);
              sawValidTargetList = true;
              return selectPrimaryChatGptTarget(targets);
            } catch (error) {
              if (error instanceof CdpTargetNotFoundError || error instanceof CdpEndpointUnavailableError) {
                await delay(pollIntervalMs, waitSignal);
                continue;
              }
              throw error;
            }
          }
        },
        timeoutMs,
        options.signal
          ? { signal: options.signal, message: "Timed out discovering the ChatGPT CDP target." }
          : { message: "Timed out discovering the ChatGPT CDP target." },
      );
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        if (sawValidTargetList) {
          throw new CdpTargetNotFoundError(undefined, { cause: error });
        }
        throw new CdpEndpointTimeoutError(undefined, { cause: error });
      }
      throw error;
    }
  }
}
