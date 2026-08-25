import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";
import { ControllerBusyError } from "../controller/ControllerTurnQueue.js";
import {
  ControllerHealth,
  ControllerCreateProjectRequest,
  ControllerCreateProjectResult,
  ControllerTurnRequest,
  ThreadwireController,
} from "../controller/ThreadwireController.js";
import { ThreadHandle } from "../domain/ThreadIdentity.js";
import { createProjectName } from "../domain/ProjectIdentity.js";
import { ThreadwireError } from "../domain/errors.js";
import { ResponseStreamEvent } from "../response/types.js";
import { TurnResult } from "../turn/types.js";
import { ThreadwireApiConfig } from "./ApiConfig.js";
import { ApiRequestError, serializePublicError } from "./PublicError.js";

export const DEFAULT_API_MAX_BODY_BYTES = 128 * 1024;
export const DEFAULT_API_MAX_PROMPT_BYTES = 64 * 1024;
export const DEFAULT_API_MAX_INFLIGHT_TURNS = 8;
export const DEFAULT_API_MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

export interface ThreadwireApiController {
  health(signal?: AbortSignal): Promise<ControllerHealth>;
  knownThreads(): readonly ThreadHandle[];
  executeTurn(
    request: ControllerTurnRequest,
    listener: (event: ResponseStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<TurnResult>;
  createProject(
    request: ControllerCreateProjectRequest,
    signal?: AbortSignal,
  ): Promise<ControllerCreateProjectResult>;
  close(): Promise<void>;
}

export interface ThreadwireHttpServerOptions {
  readonly portOverride?: number;
  readonly maxBodyBytes?: number;
  readonly maxPromptBytes?: number;
  readonly maxInflightTurns?: number;
  readonly maxSseBufferBytes?: number;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function isAllowedHost(host: string | undefined): boolean {
  return host !== undefined && /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i.test(host);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseThreadHandle(value: unknown): ThreadHandle {
  if (typeof value !== "string" || !/^tw_[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new ApiRequestError("API_REQUEST_INVALID", 400);
  }
  return value as ThreadHandle;
}

function parseTurnRequest(value: unknown, maxPromptBytes: number): ControllerTurnRequest {
  const body = asRecord(value);
  if (body === null || !hasExactKeys(body, ["target", "prompt"])) {
    throw new ApiRequestError("API_REQUEST_INVALID", 400);
  }
  if (typeof body.prompt !== "string" || body.prompt.length === 0) {
    throw new ApiRequestError("API_REQUEST_INVALID", 400);
  }
  if (Buffer.byteLength(body.prompt, "utf8") > maxPromptBytes) {
    throw new ApiRequestError("API_REQUEST_TOO_LARGE", 413);
  }

  const target = asRecord(body.target);
  if (target === null || typeof target.kind !== "string") {
    throw new ApiRequestError("API_REQUEST_INVALID", 400);
  }
  if (target.kind === "FRESH") {
    if (!hasExactKeys(target, ["kind"])) {
      throw new ApiRequestError("API_REQUEST_INVALID", 400);
    }
    return Object.freeze({
      target: Object.freeze({ kind: "FRESH" as const }),
      prompt: body.prompt,
    });
  }
  if (target.kind === "THREAD") {
    if (!hasExactKeys(target, ["kind", "threadHandle"])) {
      throw new ApiRequestError("API_REQUEST_INVALID", 400);
    }
    return Object.freeze({
      target: Object.freeze({
        kind: "THREAD" as const,
        threadHandle: parseThreadHandle(target.threadHandle),
      }),
      prompt: body.prompt,
    });
  }
  throw new ApiRequestError("API_REQUEST_INVALID", 400);
}

function parseProjectRequest(value: unknown): ControllerCreateProjectRequest {
  const body = asRecord(value);
  if (body === null || !hasExactKeys(body, ["name"]) || typeof body.name !== "string") {
    throw new ApiRequestError("API_REQUEST_INVALID", 400);
  }
  try {
    return Object.freeze({ name: createProjectName(body.name) });
  } catch {
    throw new ApiRequestError("API_REQUEST_INVALID", 400);
  }
}

function preStreamStatus(error: unknown): number {
  if (error instanceof ControllerBusyError) {
    return 429;
  }
  if (error instanceof ThreadwireError && error.code === "THREAD_NOT_FOUND") {
    return 404;
  }
  if (error instanceof ThreadwireError) {
    return 503;
  }
  return 500;
}

function boundaryStatus(error: unknown): number {
  return error instanceof ApiRequestError ? error.statusCode : 500;
}

export class ThreadwireHttpServer {
  private server: Server | null = null;
  private inflightTurns = 0;
  private readonly port: number;
  private readonly maxBodyBytes: number;
  private readonly maxPromptBytes: number;
  private readonly maxInflightTurns: number;
  private readonly maxSseBufferBytes: number;

  public constructor(
    private readonly config: ThreadwireApiConfig,
    private readonly controller: ThreadwireApiController,
    options: ThreadwireHttpServerOptions = {},
  ) {
    this.port = nonNegativeSafeInteger(options.portOverride ?? config.apiPort, "port");
    this.maxBodyBytes = positiveSafeInteger(
      options.maxBodyBytes ?? DEFAULT_API_MAX_BODY_BYTES,
      "maxBodyBytes",
    );
    this.maxPromptBytes = positiveSafeInteger(
      options.maxPromptBytes ?? DEFAULT_API_MAX_PROMPT_BYTES,
      "maxPromptBytes",
    );
    this.maxInflightTurns = positiveSafeInteger(
      options.maxInflightTurns ?? DEFAULT_API_MAX_INFLIGHT_TURNS,
      "maxInflightTurns",
    );
    this.maxSseBufferBytes = positiveSafeInteger(
      options.maxSseBufferBytes ?? DEFAULT_API_MAX_SSE_BUFFER_BYTES,
      "maxSseBufferBytes",
    );
  }

  public get boundPort(): number | null {
    const address = this.server?.address();
    return address && typeof address !== "string" ? (address as AddressInfo).port : null;
  }

  public async start(): Promise<void> {
    if (this.server !== null) {
      throw new Error("Threadwire HTTP server is already started.");
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          this.writeJson(response, boundaryStatus(error), serializePublicError(error));
        } else if (!response.writableEnded && !response.destroyed) {
          this.writeSseEvent(response, "ERROR", serializePublicError(error));
          response.end();
        }
      });
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener("listening", onListening);
        this.server = null;
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.port, this.config.apiHost);
    });
  }

  public async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await this.controller.close();
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.validateBoundary(request);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.search !== "") {
      throw new ApiRequestError("API_REQUEST_INVALID", 400);
    }

    if (request.method === "GET" && url.pathname === "/v1/health") {
      try {
        this.writeJson(response, 200, await this.controller.health());
      } catch (error) {
        this.writeJson(response, 503, serializePublicError(error));
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/threads") {
      const threads = this.controller.knownThreads().map((threadHandle) => ({ threadHandle }));
      this.writeJson(response, 200, { threads });
      return;
    }

    if (url.pathname === "/v1/turns" && request.method !== "POST") {
      response.setHeader("Allow", "POST");
      this.writeJson(
        response,
        405,
        serializePublicError(new ApiRequestError("API_REQUEST_INVALID", 405)),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/turns") {
      await this.handleTurn(request, response);
      return;
    }

    if (url.pathname === "/v1/projects" && request.method !== "POST") {
      response.setHeader("Allow", "POST");
      this.writeJson(
        response,
        405,
        serializePublicError(new ApiRequestError("API_REQUEST_INVALID", 405)),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/projects") {
      await this.handleProject(request, response);
      return;
    }

    this.writeJson(
      response,
      404,
      serializePublicError(new ApiRequestError("API_REQUEST_INVALID", 404)),
    );
  }

  private validateBoundary(request: IncomingMessage): void {
    const remoteAddress = request.socket.remoteAddress;
    if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::ffff:127.0.0.1") {
      throw new ApiRequestError("API_REQUEST_REJECTED", 403);
    }
    if (request.headers.origin !== undefined || !isAllowedHost(request.headers.host)) {
      throw new ApiRequestError("API_REQUEST_REJECTED", 403);
    }
  }

  private async handleTurn(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.inflightTurns >= this.maxInflightTurns) {
      this.writeJson(response, 429, serializePublicError(new ControllerBusyError()));
      return;
    }

    this.inflightTurns += 1;
    try {
      await this.handleAdmittedTurn(request, response);
    } finally {
      this.inflightTurns -= 1;
    }
  }

  private async handleProject(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.inflightTurns >= this.maxInflightTurns) {
      this.writeJson(response, 429, serializePublicError(new ControllerBusyError()));
      return;
    }

    this.inflightTurns += 1;
    const abortController = new AbortController();
    const onRequestAborted = (): void => abortController.abort();
    const onResponseClose = (): void => {
      if (!response.writableEnded) abortController.abort();
    };
    request.once("aborted", onRequestAborted);
    response.once("close", onResponseClose);
    try {
      const contentType = request.headers["content-type"];
      const contentEncoding = request.headers["content-encoding"];
      if (
        typeof contentType !== "string" ||
        contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" ||
        (contentEncoding !== undefined && contentEncoding !== "identity")
      ) {
        this.writeJson(
          response,
          415,
          serializePublicError(new ApiRequestError("API_REQUEST_INVALID", 415)),
        );
        return;
      }

      let body: ControllerCreateProjectRequest;
      try {
        body = parseProjectRequest(JSON.parse(await this.readBody(request)) as unknown);
      } catch (error) {
        if (abortController.signal.aborted || response.destroyed) {
          return;
        }
        const apiError = error instanceof ApiRequestError
          ? error
          : new ApiRequestError("API_REQUEST_INVALID", 400);
        this.writeJson(response, apiError.statusCode, serializePublicError(apiError));
        return;
      }

      if (abortController.signal.aborted || request.aborted || response.destroyed) {
        return;
      }
      try {
        const result = await this.controller.createProject(body, abortController.signal);
        this.writeJson(response, 201, { projectHandle: result.projectHandle });
      } catch (error) {
        if (!response.destroyed) {
          this.writeJson(response, preStreamStatus(error), serializePublicError(error));
        }
      }
    } finally {
      request.removeListener("aborted", onRequestAborted);
      response.removeListener("close", onResponseClose);
      this.inflightTurns -= 1;
    }
  }

  private async handleAdmittedTurn(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const contentType = request.headers["content-type"];
    if (
      typeof contentType !== "string" ||
      contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    ) {
      this.writeJson(
        response,
        415,
        serializePublicError(new ApiRequestError("API_REQUEST_INVALID", 415)),
      );
      return;
    }
    const contentEncoding = request.headers["content-encoding"];
    if (contentEncoding !== undefined && contentEncoding !== "identity") {
      this.writeJson(
        response,
        415,
        serializePublicError(new ApiRequestError("API_REQUEST_INVALID", 415)),
      );
      return;
    }

    let body: ControllerTurnRequest;
    try {
      body = parseTurnRequest(JSON.parse(await this.readBody(request)) as unknown, this.maxPromptBytes);
    } catch (error) {
      const apiError =
        error instanceof ApiRequestError
          ? error
          : new ApiRequestError("API_REQUEST_INVALID", 400);
      this.writeJson(response, apiError.statusCode, serializePublicError(apiError));
      return;
    }

    const abortController = new AbortController();
    const onRequestAborted = (): void => abortController.abort();
    const onResponseClose = (): void => {
      if (!response.writableEnded) {
        abortController.abort();
      }
    };
    request.once("aborted", onRequestAborted);
    response.once("close", onResponseClose);

    let domainCompleted = false;
    let transportOpen = true;
    const listener = (event: ResponseStreamEvent): void => {
      if (!transportOpen || response.destroyed || response.writableEnded) {
        return;
      }
      if (event.type === "COMPLETED") {
        domainCompleted = true;
        return;
      }
      if (!this.writeSseEvent(response, event.type, { text: event.text })) {
        transportOpen = false;
        abortController.abort();
      }
    };

    let turnPromise: Promise<TurnResult>;
    try {
      turnPromise = this.controller.executeTurn(body, listener, abortController.signal);
    } catch (error) {
      request.removeListener("aborted", onRequestAborted);
      response.removeListener("close", onResponseClose);
      this.writeJson(response, preStreamStatus(error), serializePublicError(error));
      return;
    }

    this.openSse(response);
    try {
      const result = await turnPromise;
      if (!domainCompleted) {
        throw new Error("Turn completed without the public completion boundary.");
      }
      if (transportOpen && !response.destroyed && !response.writableEnded) {
        transportOpen = this.writeSseEvent(response, "COMPLETED", {
          threadHandle: result.threadHandle,
          newlyRegistered: result.created,
        });
      }
    } catch (error) {
      if (transportOpen && !response.destroyed && !response.writableEnded) {
        this.writeSseEvent(response, "ERROR", serializePublicError(error));
      }
    } finally {
      request.removeListener("aborted", onRequestAborted);
      response.removeListener("close", onResponseClose);
      if (!response.destroyed && !response.writableEnded) {
        response.end();
      }
    }
  }

  private async readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let total = 0;
    let exceeded = false;

    for await (const value of request) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      total = Math.min(this.maxBodyBytes + 1, total + chunk.length);
      if (total > this.maxBodyBytes) {
        exceeded = true;
        chunks.length = 0;
        continue;
      }
      if (!exceeded) {
        chunks.push(chunk);
      }
    }

    if (exceeded) {
      throw new ApiRequestError("API_REQUEST_TOO_LARGE", 413);
    }
    return Buffer.concat(chunks, total).toString("utf8");
  }

  private openSse(response: ServerResponse): void {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.flushHeaders();
  }

  private writeSseEvent(response: ServerResponse, event: string, data: unknown): boolean {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const bytes = Buffer.byteLength(frame, "utf8");
    if (response.writableLength + bytes > this.maxSseBufferBytes) {
      return false;
    }
    response.write(frame, "utf8");
    return true;
  }

  private writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
    if (response.headersSent) {
      return;
    }
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end(JSON.stringify(body));
  }
}

export function createThreadwireHttpServer(
  config: ThreadwireApiConfig,
  controller: ThreadwireController,
): ThreadwireHttpServer {
  return new ThreadwireHttpServer(config, controller);
}
