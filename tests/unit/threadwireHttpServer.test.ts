import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ThreadHandle } from "../../src/domain/ThreadIdentity.js";
import { ProjectHandle } from "../../src/domain/ProjectIdentity.js";
import { ProjectCreationFailedError, ThreadNotFoundError, TurnWriteFailedError } from "../../src/domain/errors.js";
import { ControllerBusyError } from "../../src/controller/ControllerTurnQueue.js";
import { ControllerTurnRequest } from "../../src/controller/ThreadwireController.js";
import {
  ThreadwireApiController,
  ThreadwireHttpServer,
} from "../../src/api/ThreadwireHttpServer.js";
import { ResponseStreamEvent } from "../../src/response/types.js";
import { TurnResult } from "../../src/turn/types.js";

const HANDLE = "tw_http_test" as ThreadHandle;
const PROJECT_HANDLE = "prj_http_test" as ProjectHandle;

type HttpResult = Readonly<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}>;

function turnResult(created: boolean): TurnResult {
  if (created) {
    return Object.freeze({ kind: "THREAD" as const, threadHandle: HANDLE, created: true as const });
  }
  return Object.freeze({ kind: "THREAD" as const, threadHandle: HANDLE, created: false as const });
}

class FakeController implements ThreadwireApiController {
  public closed = false;
  public executeImpl: (
    request: ControllerTurnRequest,
    listener: (event: ResponseStreamEvent) => void,
    signal?: AbortSignal,
  ) => Promise<TurnResult> = async () => turnResult(true);
  public createProjectImpl: (request: { readonly name: string }, signal?: AbortSignal) => Promise<{ projectHandle: ProjectHandle }> =
    async () => ({ projectHandle: PROJECT_HANDLE });

  public async health() {
    return { classic: "RUNNING" as const, cdp: "CONNECTED" as const };
  }

  public knownThreads(): readonly ThreadHandle[] {
    return [HANDLE];
  }

  public executeTurn(
    request: ControllerTurnRequest,
    listener: (event: ResponseStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<TurnResult> {
    return this.executeImpl(request, listener, signal);
  }

  public createProject(
    request: { readonly name: string },
    signal?: AbortSignal,
  ): Promise<{ projectHandle: ProjectHandle }> {
    return this.createProjectImpl(request, signal);
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

async function startServer(
  t: test.TestContext,
  controller = new FakeController(),
  options: ConstructorParameters<typeof ThreadwireHttpServer>[2] = {},
) {
  const server = new ThreadwireHttpServer(
    { apiHost: "127.0.0.1", apiPort: 9224 },
    controller,
    { ...options, portOverride: 0 },
  );
  await server.start();
  const port = server.boundPort;
  assert.notEqual(port, null);
  t.after(async () => {
    await server.close();
  });
  return { controller, server, port: port! };
}

async function request(
  port: number,
  options: Readonly<{
    method?: string;
    path?: string;
    headers?: http.OutgoingHttpHeaders;
    body?: string;
  }> = {},
): Promise<HttpResult> {
  return await new Promise<HttpResult>((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/v1/health",
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.once("error", reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

function jsonHeaders(): http.OutgoingHttpHeaders {
  return { "Content-Type": "application/json" };
}

test("health and thread listing expose only safe local controller state", async (t) => {
  const fixture = await startServer(t);

  const health = await request(fixture.port);
  assert.equal(health.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), { classic: "RUNNING", cdp: "CONNECTED" });
  assert.equal(health.headers["access-control-allow-origin"], undefined);

  const threads = await request(fixture.port, { path: "/v1/threads" });
  assert.equal(threads.statusCode, 200);
  assert.deepEqual(JSON.parse(threads.body), { threads: [{ threadHandle: HANDLE }] });
  assert.equal(threads.body.includes("chatgpt.com/c/"), false);
});

test("browser Origin and non-loopback Host headers are rejected", async (t) => {
  const fixture = await startServer(t);

  const origin = await request(fixture.port, {
    headers: { Origin: "https://example.invalid" },
  });
  assert.equal(origin.statusCode, 403);
  assert.equal(JSON.parse(origin.body).error.code, "API_REQUEST_REJECTED");

  const host = await request(fixture.port, {
    headers: { Host: "attacker.invalid" },
  });
  assert.equal(host.statusCode, 403);
  assert.equal(JSON.parse(host.body).error.code, "API_REQUEST_REJECTED");
});

test("turn requests require strict JSON shape and a bounded prompt", async (t) => {
  const fixture = await startServer(t, new FakeController(), { maxPromptBytes: 8 });

  const badType = await request(fixture.port, {
    method: "POST",
    path: "/v1/turns",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(badType.statusCode, 415);

  const extraField = await request(fixture.port, {
    method: "POST",
    path: "/v1/turns",
    headers: jsonHeaders(),
    body: JSON.stringify({ target: { kind: "FRESH" }, prompt: "ok", extra: true }),
  });
  assert.equal(extraField.statusCode, 400);

  const largePrompt = await request(fixture.port, {
    method: "POST",
    path: "/v1/turns",
    headers: jsonHeaders(),
    body: JSON.stringify({ target: { kind: "FRESH" }, prompt: "123456789" }),
  });
  assert.equal(largePrompt.statusCode, 413);
  assert.equal(JSON.parse(largePrompt.body).error.retryable, false);
});

test("request body storage is bounded independently from prompt validation", async (t) => {
  const fixture = await startServer(t, new FakeController(), { maxBodyBytes: 32 });
  const oversized = await request(fixture.port, {
    method: "POST",
    path: "/v1/turns",
    headers: jsonHeaders(),
    body: JSON.stringify({ target: { kind: "FRESH" }, prompt: "x".repeat(64) }),
  });

  assert.equal(oversized.statusCode, 413);
  assert.equal(JSON.parse(oversized.body).error.code, "API_REQUEST_TOO_LARGE");
});

test("project creation requires strict JSON and returns only an opaque handle", async (t) => {
  const controller = new FakeController();
  let observed: { readonly name: string } | null = null;
  controller.createProjectImpl = async (requestBody) => {
    observed = requestBody;
    return {
      projectHandle: PROJECT_HANDLE,
      locator: "https://chatgpt.com/g/g-p-private/project",
    } as { projectHandle: ProjectHandle };
  };
  const fixture = await startServer(t, controller);

  const invalid = await request(fixture.port, {
    method: "POST",
    path: "/v1/projects",
    headers: jsonHeaders(),
    body: JSON.stringify({ name: "Project", extra: true }),
  });
  assert.equal(invalid.statusCode, 400);

  const response = await request(fixture.port, {
    method: "POST",
    path: "/v1/projects",
    headers: jsonHeaders(),
    body: JSON.stringify({ name: "Threadwire Acceptance" }),
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(observed, { name: "Threadwire Acceptance" });
  assert.deepEqual(JSON.parse(response.body), { projectHandle: PROJECT_HANDLE });
  assert.equal(response.body.includes("chatgpt.com"), false);
  assert.equal(response.body.includes("g-p-"), false);
});

test("project failures expose only stable sanitized errors", async (t) => {
  const controller = new FakeController();
  controller.createProjectImpl = async () => {
    throw new ProjectCreationFailedError("PROJECT_LOCATOR_CANARY", {
      cause: { secret: "PROJECT_CAUSE_CANARY" },
    });
  };
  const fixture = await startServer(t, controller);
  const response = await request(fixture.port, {
    method: "POST",
    path: "/v1/projects",
    headers: jsonHeaders(),
    body: JSON.stringify({ name: "Threadwire Acceptance" }),
  });
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error.code, "PROJECT_CREATION_FAILED");
  assert.equal(response.body.includes("PROJECT_LOCATOR_CANARY"), false);
  assert.equal(response.body.includes("PROJECT_CAUSE_CANARY"), false);
});

test("accepted turn streams safe events and keeps COMPLETED terminal", async (t) => {
  const controller = new FakeController();
  controller.executeImpl = async (_request, listener) => {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    listener({ type: "TEXT_DELTA", text: "partial" });
    listener({ type: "FINAL_TEXT", text: "authoritative" });
    listener({ type: "COMPLETED" });
    return turnResult(true);
  };
  const fixture = await startServer(t, controller);

  const response = await request(fixture.port, {
    method: "POST",
    path: "/v1/turns",
    headers: jsonHeaders(),
    body: JSON.stringify({ target: { kind: "FRESH" }, prompt: "question" }),
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /^text\/event-stream/);
  assert.match(response.body, /event: TEXT_DELTA\ndata: \{"text":"partial"\}/);
  assert.match(response.body, /event: FINAL_TEXT\ndata: \{"text":"authoritative"\}/);
  assert.match(
    response.body,
    new RegExp(`event: COMPLETED\\ndata: \\{"threadHandle":"${HANDLE}","newlyRegistered":true\\}`),
  );
  assert.equal((response.body.match(/event: COMPLETED/g) ?? []).length, 1);
  assert.ok(response.body.lastIndexOf("event: COMPLETED") > response.body.lastIndexOf("event: FINAL_TEXT"));
});

test("existing target preserves the opaque handle at the controller boundary", async (t) => {
  const controller = new FakeController();
  let observed: ControllerTurnRequest | null = null;
  controller.executeImpl = async (requestBody, listener) => {
    observed = requestBody;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    listener({ type: "FINAL_TEXT", text: "done" });
    listener({ type: "COMPLETED" });
    return turnResult(false);
  };
  const fixture = await startServer(t, controller);

  const response = await request(fixture.port, {
    method: "POST",
    path: "/v1/turns",
    headers: jsonHeaders(),
    body: JSON.stringify({
      target: { kind: "THREAD", threadHandle: HANDLE },
      prompt: "follow-up",
    }),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(observed, {
    target: { kind: "THREAD", threadHandle: HANDLE },
    prompt: "follow-up",
  });
  assert.match(response.body, /"newlyRegistered":false/);
});

test("capacity and unknown-handle failures stay pre-stream HTTP errors", async (t) => {
  const busyController = new FakeController();
  busyController.executeImpl = () => {
    throw new ControllerBusyError();
  };
  const busy = await startServer(t, busyController);
  const busyResponse = await request(busy.port, {
    method: "POST",
    path: "/v1/turns",
    headers: jsonHeaders(),
    body: JSON.stringify({ target: { kind: "FRESH" }, prompt: "x" }),
  });
  assert.equal(busyResponse.statusCode, 429);
  assert.equal(JSON.parse(busyResponse.body).error.code, "CONTROLLER_BUSY");

  const missingController = new FakeController();
  missingController.executeImpl = () => {
    throw new ThreadNotFoundError();
  };
  const missing = await startServer(t, missingController);
  const missingResponse = await request(missing.port, {
    method: "POST",
    path: "/v1/turns",
    headers: jsonHeaders(),
    body: JSON.stringify({ target: { kind: "THREAD", threadHandle: HANDLE }, prompt: "x" }),
  });
  assert.equal(missingResponse.statusCode, 404);
  assert.equal(JSON.parse(missingResponse.body).error.code, "THREAD_NOT_FOUND");
});

test("stream errors expose only stable code/message and never recurse into causes", async (t) => {
  const controller = new FakeController();
  controller.executeImpl = async () => {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    throw new TurnWriteFailedError("OUTWARD_MESSAGE_CANARY", {
      cause: { secret: "CAUSE_GRAPH_CANARY" },
    });
  };
  const fixture = await startServer(t, controller);

  const response = await request(fixture.port, {
    method: "POST",
    path: "/v1/turns",
    headers: jsonHeaders(),
    body: JSON.stringify({ target: { kind: "FRESH" }, prompt: "x" }),
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /event: ERROR/);
  assert.match(response.body, /"code":"TURN_WRITE_FAILED"/);
  assert.match(response.body, /"message":"Threadwire operation failed\."/);
  assert.match(response.body, /"retryable":false/);
  assert.equal(response.body.includes("OUTWARD_MESSAGE_CANARY"), false);
  assert.equal(response.body.includes("CAUSE_GRAPH_CANARY"), false);
  assert.equal(response.body.includes("cause"), false);
});
