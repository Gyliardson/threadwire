import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ControllerBusyError } from "../../src/controller/ControllerTurnQueue.js";
import { ThreadHandle } from "../../src/domain/ThreadIdentity.js";
import { ProjectHandle } from "../../src/domain/ProjectIdentity.js";
import { ResponseStreamEvent } from "../../src/response/types.js";
import { TurnResult } from "../../src/turn/types.js";
import {
  ThreadwireApiController,
  ThreadwireHttpServer,
} from "../../src/api/ThreadwireHttpServer.js";

const THREAD_HANDLE = "tw_recovery_http" as ThreadHandle;
const PROJECT_HANDLE = "prj_recovery_http" as ProjectHandle;

type Result = Readonly<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }>;

class Controller implements ThreadwireApiController {
  public recoverCalls = 0;
  public recoverImpl: (signal?: AbortSignal) => Promise<{ classic: "RUNNING"; cdp: "CONNECTED" }> =
    async () => ({ classic: "RUNNING", cdp: "CONNECTED" });

  public async health() {
    return { classic: "RUNNING" as const, cdp: "CONNECTED" as const };
  }

  public knownThreads(): readonly ThreadHandle[] {
    return [THREAD_HANDLE];
  }

  public async executeTurn(
    _request: unknown,
    listener: (event: ResponseStreamEvent) => void,
  ): Promise<TurnResult> {
    listener({ type: "FINAL_TEXT", text: "done" });
    listener({ type: "COMPLETED" });
    return { kind: "THREAD", threadHandle: THREAD_HANDLE, created: false };
  }

  public confirmTurnCompletion(_result: TurnResult): void {}
  public rollbackTurnCompletion(_result: TurnResult): void {}

  public async createProject(): Promise<{ projectHandle: ProjectHandle }> {
    return { projectHandle: PROJECT_HANDLE };
  }

  public async recoverRuntime(signal?: AbortSignal) {
    this.recoverCalls += 1;
    return await this.recoverImpl(signal);
  }

  public async close(): Promise<void> {}
}

async function start(t: test.TestContext, controller = new Controller()) {
  const server = new ThreadwireHttpServer(
    { apiHost: "127.0.0.1", apiPort: 9224 },
    controller,
    { portOverride: 0 },
  );
  await server.start();
  const port = server.boundPort;
  assert.notEqual(port, null);
  t.after(async () => await server.close());
  return { controller, port: port! };
}

async function request(
  port: number,
  options: Readonly<{
    method?: string;
    path?: string;
    headers?: http.OutgoingHttpHeaders;
    body?: string;
  }> = {},
): Promise<Result> {
  return await new Promise<Result>((resolve, reject) => {
    const outgoing = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: options.method ?? "POST",
        path: options.path ?? "/v1/runtime/recover",
        headers: options.headers,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.once("end", () => resolve({
          statusCode: incoming.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: incoming.headers,
        }));
      },
    );
    outgoing.once("error", reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

const jsonHeaders = (): http.OutgoingHttpHeaders => ({ "Content-Type": "application/json" });

test("runtime recovery accepts only strict empty JSON and returns sanitized health", async (t) => {
  const fixture = await start(t);
  const response = await request(fixture.port, {
    headers: jsonHeaders(),
    body: "{}",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { classic: "RUNNING", cdp: "CONNECTED" });
  assert.equal(fixture.controller.recoverCalls, 1);
  assert.equal(response.body.includes("pid"), false);
  assert.equal(response.body.includes("generation"), false);
  assert.equal(response.body.includes("target"), false);
  assert.equal(response.body.includes("chatgpt.com"), false);
});

test("runtime recovery rejects extra keys, query strings, wrong methods and browser Origin", async (t) => {
  const fixture = await start(t);

  const extra = await request(fixture.port, {
    headers: jsonHeaders(),
    body: JSON.stringify({ generation: 7 }),
  });
  assert.equal(extra.statusCode, 400);

  const query = await request(fixture.port, {
    path: "/v1/runtime/recover?force=true",
    headers: jsonHeaders(),
    body: "{}",
  });
  assert.equal(query.statusCode, 400);

  const method = await request(fixture.port, {
    method: "GET",
  });
  assert.equal(method.statusCode, 405);
  assert.equal(method.headers.allow, "POST");

  const origin = await request(fixture.port, {
    headers: { ...jsonHeaders(), Origin: "https://example.invalid" },
    body: "{}",
  });
  assert.equal(origin.statusCode, 403);
  assert.equal(fixture.controller.recoverCalls, 0);
});

test("runtime recovery uses the stable retry contract without exposing internal causes", async (t) => {
  const busyController = new Controller();
  busyController.recoverImpl = async () => {
    throw new ControllerBusyError();
  };
  const busy = await start(t, busyController);
  const busyResponse = await request(busy.port, { headers: jsonHeaders(), body: "{}" });
  assert.equal(busyResponse.statusCode, 429);
  assert.deepEqual(JSON.parse(busyResponse.body), {
    error: {
      code: "CONTROLLER_BUSY",
      message: "Threadwire controller capacity is full.",
      retryable: true,
    },
  });

  const failingController = new Controller();
  failingController.recoverImpl = async () => {
    throw new Error("RUNTIME_INTERNAL_CANARY");
  };
  const failing = await start(t, failingController);
  const failure = await request(failing.port, { headers: jsonHeaders(), body: "{}" });
  assert.equal(failure.statusCode, 500);
  assert.equal(JSON.parse(failure.body).error.retryable, false);
  assert.equal(failure.body.includes("RUNTIME_INTERNAL_CANARY"), false);
});
