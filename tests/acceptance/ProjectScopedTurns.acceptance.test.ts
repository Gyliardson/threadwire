import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { ThreadwireHttpServer } from "../../src/api/ThreadwireHttpServer.js";
import { CdpSessionManager } from "../../src/cdp/CdpSessionManager.js";
import { loadConfig } from "../../src/config/ControllerConfig.js";
import { ThreadwireController } from "../../src/controller/ThreadwireController.js";
import { sameRuntimeIdentity } from "../../src/domain/RuntimeGeneration.js";
import { ProjectHandle } from "../../src/domain/ProjectIdentity.js";
import {
  ThreadHandle,
  conversationBelongsToProject,
} from "../../src/domain/ThreadIdentity.js";
import { ProjectCreator } from "../../src/project/ProjectCreator.js";
import { ProjectRegistry } from "../../src/project/ProjectRegistry.js";
import { ReadinessController } from "../../src/readiness/ReadinessController.js";
import { ConversationRouter } from "../../src/routing/ConversationRouter.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";
import { ThreadRegistry } from "../../src/routing/ThreadRegistry.js";
import { ClassicSupervisor } from "../../src/runtime/ClassicSupervisor.js";
import { TurnExecutor } from "../../src/turn/TurnExecutor.js";

type HttpResponse = Readonly<{
  readonly statusCode: number;
  readonly contentType: string | undefined;
  readonly body: string;
}>;

type SseEvent = Readonly<{
  readonly event: string;
  readonly data: Record<string, unknown>;
}>;

const enabled =
  process.env.THREADWIRE_ACCEPT_DESTRUCTIVE_TESTS === "1" &&
  process.env.THREADWIRE_ACCEPT_PROJECT_SCOPED_TURNS === "1";
const REQUEST_DEADLINE_MS = 120_000;

function nonce(): string {
  return randomBytes(8).toString("hex");
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseSse(body: string): readonly SseEvent[] {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (event === undefined || data === undefined) {
        throw new Error("Project acceptance received a malformed SSE frame.");
      }
      return Object.freeze({
        event,
        data: record(JSON.parse(data) as unknown, "Project acceptance SSE data was malformed."),
      });
    });
}

async function request(
  port: number,
  method: "GET" | "POST",
  path: string,
  body?: string,
): Promise<HttpResponse> {
  return await new Promise<HttpResponse>((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = {};
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body, "utf8");
    }
    const outgoing = http.request(
      { hostname: "127.0.0.1", port, method, path, headers },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        incoming.once("error", (error) => {
          clearTimeout(deadline);
          reject(error);
        });
        incoming.once("end", () => {
          clearTimeout(deadline);
          resolve(Object.freeze({
            statusCode: incoming.statusCode ?? 0,
            contentType:
              typeof incoming.headers["content-type"] === "string"
                ? incoming.headers["content-type"]
                : undefined,
            body: Buffer.concat(chunks).toString("utf8"),
          }));
        });
      },
    );
    const deadline = setTimeout(() => {
      outgoing.destroy(new Error("Project acceptance request exceeded its deadline."));
    }, REQUEST_DEADLINE_MS);
    deadline.unref();
    outgoing.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    if (body !== undefined) outgoing.write(body, "utf8");
    outgoing.end();
  });
}

function validateTurn(
  response: HttpResponse,
  expectedOutput: string,
  expectedNew: boolean,
  expectedHandle?: ThreadHandle,
  requireDelta = false,
): ThreadHandle {
  assert.equal(response.statusCode, 200);
  assert.equal(response.contentType?.startsWith("text/event-stream"), true);
  const events = parseSse(response.body);
  const deltas = events.filter((event) => event.event === "TEXT_DELTA");
  const finals = events.filter((event) => event.event === "FINAL_TEXT");
  const completed = events.filter((event) => event.event === "COMPLETED");
  const errors = events.filter((event) => event.event === "ERROR");
  if (errors.length > 0) {
    const publicError = record(errors[0]!.data.error, "Project turn returned a malformed public error.");
    assert.fail(
      `Project turn returned ${String(publicError.code ?? "an unknown error")}: ${String(publicError.message ?? "No public message.")}`,
    );
  }
  if (requireDelta) assert.ok(deltas.length >= 1, "Project turn returned no text delta.");
  assert.equal(finals.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(events.at(-2)?.event, "FINAL_TEXT");
  assert.equal(events.at(-1)?.event, "COMPLETED");

  const deltaText = deltas.map((event) => event.data.text).join("");
  assert.equal(deltas.every((event) => exactKeys(event.data, ["text"])), true);
  assert.equal(deltas.every((event) => typeof event.data.text === "string"), true);
  assert.equal(exactKeys(finals[0]!.data, ["text"]), true);
  assert.equal(typeof finals[0]!.data.text, "string");
  if (deltas.length > 0) {
    assert.equal(deltaText === finals[0]!.data.text, true, "Project delta text did not match final text.");
  }
  assert.equal(
    String(finals[0]!.data.text).trim() === expectedOutput,
    true,
    "Project final text did not match the synthetic marker.",
  );

  const completion = completed[0]!.data;
  assert.equal(exactKeys(completion, ["threadHandle", "newlyRegistered"]), true);
  assert.equal(
    typeof completion.threadHandle === "string" && /^tw_[A-Za-z0-9_-]{1,128}$/.test(completion.threadHandle),
    true,
  );
  assert.equal(completion.newlyRegistered, expectedNew);
  const handle = completion.threadHandle as ThreadHandle;
  if (expectedHandle !== undefined) assert.equal(handle, expectedHandle);
  return handle;
}

test(
  "native Project-scoped first turn and opaque THREAD follow-up",
  { skip: !enabled },
  async (context) => {
    const config = loadConfig();
    const runtime = new ClassicSupervisor(config);
    const before = await runtime.inspect();
    assert.equal(before.isRunning, true);
    assert.notEqual(before.mainProcess, null);
    const beforeMain = before.mainProcess!;
    context.after(async () => {
      const after = await runtime.inspect();
      assert.equal(after.isRunning, true);
      assert.notEqual(after.mainProcess, null);
      assert.equal(
        sameRuntimeIdentity(
          { pid: beforeMain.pid, creationTime: beforeMain.creationTime },
          { pid: after.mainProcess!.pid, creationTime: after.mainProcess!.creationTime },
        ),
        true,
      );
    });

    const threadRegistry = new ThreadRegistry();
    const projectRegistry = new ProjectRegistry();
    const scheduler = new OperationScheduler(runtime);
    const cdp = new CdpSessionManager(config, runtime);
    const readiness = new ReadinessController(cdp);
    const router = new ConversationRouter(threadRegistry, scheduler, cdp, readiness);
    const executor = new TurnExecutor(threadRegistry, scheduler, readiness, cdp);
    const projectCreator = new ProjectCreator(projectRegistry, scheduler, cdp);
    const controller = new ThreadwireController({
      runtime,
      cdp,
      registry: threadRegistry,
      projectRegistry,
      router,
      executor,
      projectCreator,
    });
    const server = new ThreadwireHttpServer(
      { apiHost: "127.0.0.1", apiPort: 9224 },
      controller,
      { portOverride: 0 },
    );

    try {
      await server.start();
      const port = server.boundPort;
      assert.notEqual(port, null);

      const projectResponse = await request(
        port!,
        "POST",
        "/v1/projects",
        JSON.stringify({ name: `Threadwire Project Acceptance ${nonce()}` }),
      );
      assert.equal(projectResponse.statusCode, 201);
      const projectData = record(
        JSON.parse(projectResponse.body) as unknown,
        "Project acceptance response was malformed.",
      );
      assert.equal(exactKeys(projectData, ["projectHandle"]), true);
      assert.equal(
        typeof projectData.projectHandle === "string" && /^prj_[A-Za-z0-9_-]{1,128}$/.test(projectData.projectHandle),
        true,
      );
      const projectHandle = projectData.projectHandle as ProjectHandle;
      const projectLocator = projectRegistry.resolve(projectHandle);

      const firstOutput = `TW_PROJECT_OUT_${nonce()}`;
      const first = await request(
        port!,
        "POST",
        "/v1/turns",
        JSON.stringify({
          target: { kind: "PROJECT", projectHandle },
          prompt: `Reply with exactly the token on the next line. Do not add punctuation or any other text.\n${firstOutput}`,
        }),
      );
      const threadHandle = validateTurn(first, firstOutput, true, undefined, true);
      const conversationLocator = threadRegistry.resolve(threadHandle);
      assert.equal(conversationBelongsToProject(conversationLocator, projectLocator), true);

      const followUpOutput = `TW_PROJECT_FOLLOWUP_${nonce()}`;
      const followUp = await request(
        port!,
        "POST",
        "/v1/turns",
        JSON.stringify({
          target: { kind: "THREAD", threadHandle },
          prompt: `Reply with exactly the token on the next line. Do not add punctuation or any other text.\n${followUpOutput}`,
        }),
      );
      validateTurn(followUp, followUpOutput, false, threadHandle);

      const threads = await request(port!, "GET", "/v1/threads");
      assert.equal(threads.statusCode, 200);
      for (const publicBody of [projectResponse.body, first.body, followUp.body, threads.body]) {
        assert.equal(publicBody.includes(projectLocator), false);
        assert.equal(publicBody.includes(conversationLocator), false);
        assert.equal(publicBody.includes("https://chatgpt.com"), false);
      }
    } finally {
      await server.close().catch(() => undefined);
    }
  },
);
