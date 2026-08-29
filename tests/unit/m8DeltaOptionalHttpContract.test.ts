import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ThreadwireHttpServer, ThreadwireApiController } from "../../src/api/ThreadwireHttpServer.js";
import { ControllerTurnRequest } from "../../src/controller/ThreadwireController.js";
import { ThreadHandle } from "../../src/domain/ThreadIdentity.js";
import { ProjectHandle } from "../../src/domain/ProjectIdentity.js";
import { ResponseStreamEvent } from "../../src/response/types.js";
import { TurnResult } from "../../src/turn/types.js";

const HANDLE = "tw_delta_optional" as ThreadHandle;

class DeltaFreeController implements ThreadwireApiController {
  public confirmTurnCompletion(_result: TurnResult): void {}

  public rollbackTurnCompletion(_result: TurnResult): void {}
  public async health() {
    return { classic: "RUNNING" as const, cdp: "CONNECTED" as const };
  }

  public knownThreads(): readonly ThreadHandle[] {
    return [HANDLE];
  }

  public async executeTurn(
    _request: ControllerTurnRequest,
    listener: (event: ResponseStreamEvent) => void,
    _signal?: AbortSignal,
  ): Promise<TurnResult> {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    listener({ type: "FINAL_TEXT", text: "authoritative" });
    listener({ type: "COMPLETED" });
    return Object.freeze({
      kind: "THREAD" as const,
      threadHandle: HANDLE,
      created: false as const,
    });
  }

  public async createProject(): Promise<{ projectHandle: ProjectHandle }> {
    return { projectHandle: "prj_delta_optional" as ProjectHandle };
  }

  public async close(): Promise<void> {}
}

async function postTurn(port: number): Promise<Readonly<{ statusCode: number; body: string }>> {
  const body = JSON.stringify({
    target: { kind: "THREAD", threadHandle: HANDLE },
    prompt: "follow-up",
  });

  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/turns",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body, "utf8"),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.once("error", reject);
        response.once("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.once("error", reject);
    req.write(body, "utf8");
    req.end();
  });
}

test("HTTP SSE success allows zero TEXT_DELTA events before FINAL_TEXT and COMPLETED", async (t) => {
  const server = new ThreadwireHttpServer(
    { apiHost: "127.0.0.1", apiPort: 9224 },
    new DeltaFreeController(),
    { portOverride: 0 },
  );
  await server.start();
  t.after(async () => await server.close());

  const port = server.boundPort;
  assert.notEqual(port, null);
  if (port === null) {
    throw new Error("M8 test server did not expose a bound loopback port.");
  }

  const response = await postTurn(port);
  assert.equal(response.statusCode, 200);
  assert.equal((response.body.match(/event: TEXT_DELTA/g) ?? []).length, 0);
  assert.equal((response.body.match(/event: FINAL_TEXT/g) ?? []).length, 1);
  assert.equal((response.body.match(/event: COMPLETED/g) ?? []).length, 1);
  assert.ok(response.body.lastIndexOf("event: FINAL_TEXT") < response.body.lastIndexOf("event: COMPLETED"));
  assert.equal(response.body.trimEnd().endsWith('data: {"threadHandle":"tw_delta_optional","newlyRegistered":false}'), true);
});
