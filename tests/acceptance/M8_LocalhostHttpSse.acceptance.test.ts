import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { assertApiConfigCompatible, loadApiConfig } from "../../src/api/ApiConfig.js";
import { ThreadwireHttpServer } from "../../src/api/ThreadwireHttpServer.js";
import { loadConfig } from "../../src/config/ControllerConfig.js";
import { createThreadwireController } from "../../src/controller/ThreadwireController.js";
import { sameRuntimeIdentity } from "../../src/domain/RuntimeGeneration.js";
import { ClassicProcessObservation } from "../../src/domain/RuntimeState.js";
import { ClassicSupervisor } from "../../src/runtime/ClassicSupervisor.js";

type HttpResponse = Readonly<{
  statusCode: number;
  contentType: string | undefined;
  body: string;
}>;

type SseEvent = Readonly<{
  event: string;
  data: unknown;
}>;

const m8Enabled =
  process.env.THREADWIRE_ACCEPT_DESTRUCTIVE_TESTS === "1" &&
  process.env.THREADWIRE_ACCEPT_M8_HTTP_SSE === "1";

function identity(process: ClassicProcessObservation) {
  return { pid: process.pid, creationTime: process.creationTime };
}

function nonce(): string {
  return randomBytes(8).toString("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  const record = asRecord(value);
  if (record === null) {
    throw new Error(message);
  }
  return record;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function parseJsonRecord(body: string, message: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error(message);
  }
  return requireRecord(parsed, message);
}

function parseSse(body: string): readonly SseEvent[] {
  const normalized = body.replace(/\r\n/g, "\n");
  const frames = normalized.split("\n\n").filter((frame) => frame.trim().length > 0);
  const events: SseEvent[] = [];

  for (const frame of frames) {
    const lines = frame.split("\n");
    const eventLine = lines.find((line) => line.startsWith("event: "));
    const dataLine = lines.find((line) => line.startsWith("data: "));
    if (eventLine === undefined || dataLine === undefined) {
      throw new Error("M8 SSE frame did not contain the required event/data fields.");
    }

    let data: unknown;
    try {
      data = JSON.parse(dataLine.slice("data: ".length)) as unknown;
    } catch {
      throw new Error("M8 SSE frame contained malformed JSON data.");
    }

    events.push(Object.freeze({
      event: eventLine.slice("event: ".length),
      data,
    }));
  }

  return Object.freeze(events);
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

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.once("error", reject);
        response.once("end", () => {
          resolve(Object.freeze({
            statusCode: response.statusCode ?? 0,
            contentType:
              typeof response.headers["content-type"] === "string"
                ? response.headers["content-type"]
                : undefined,
            body: Buffer.concat(chunks).toString("utf8"),
          }));
        });
      },
    );
    req.once("error", reject);
    if (body !== undefined) {
      req.write(body, "utf8");
    }
    req.end();
  });
}

function validateTurnSse(
  response: HttpResponse,
  inputMarker: string,
  outputMarker: string,
  expectedNewlyRegistered: boolean,
  expectedHandle?: string,
): string {
  assert.equal(response.statusCode, 200);
  assert.equal(response.contentType?.startsWith("text/event-stream"), true);
  assert.equal(response.body.includes("https://chatgpt.com/c/"), false);

  const events = parseSse(response.body);
  assert.equal(events.length >= 3, true);
  assert.equal(events.every((event) => ["TEXT_DELTA", "FINAL_TEXT", "COMPLETED"].includes(event.event)), true);

  const deltaEvents = events.filter((event) => event.event === "TEXT_DELTA");
  const finalEvents = events.filter((event) => event.event === "FINAL_TEXT");
  const completedEvents = events.filter((event) => event.event === "COMPLETED");

  assert.equal(deltaEvents.length >= 1, true);
  assert.equal(finalEvents.length, 1);
  assert.equal(completedEvents.length, 1);
  assert.equal(events.at(-1)?.event, "COMPLETED");
  assert.equal(events.at(-2)?.event, "FINAL_TEXT");

  let deltaText = "";
  for (const event of deltaEvents) {
    const data = requireRecord(event.data, "M8 TEXT_DELTA data was not an object.");
    assert.equal(hasExactKeys(data, ["text"]), true);
    assert.equal(typeof data.text, "string");
    if (typeof data.text === "string") {
      deltaText += data.text;
    }
  }
  assert.equal(deltaText.includes(inputMarker), false);

  const finalData = requireRecord(finalEvents[0]?.data, "M8 FINAL_TEXT data was not an object.");
  assert.equal(hasExactKeys(finalData, ["text"]), true);
  assert.equal(typeof finalData.text, "string");
  if (typeof finalData.text !== "string") {
    throw new Error("M8 FINAL_TEXT text was unavailable.");
  }
  assert.equal(finalData.text.includes(inputMarker), false);
  assert.equal(finalData.text.trim() === outputMarker, true);

  const completedData = requireRecord(
    completedEvents[0]?.data,
    "M8 COMPLETED data was not an object.",
  );
  assert.equal(hasExactKeys(completedData, ["threadHandle", "newlyRegistered"]), true);
  assert.equal(
    typeof completedData.threadHandle === "string" &&
      /^tw_[A-Za-z0-9_-]{1,128}$/.test(completedData.threadHandle),
    true,
  );
  assert.equal(completedData.newlyRegistered, expectedNewlyRegistered);
  if (typeof completedData.threadHandle !== "string") {
    throw new Error("M8 COMPLETED did not contain an opaque ThreadHandle.");
  }
  if (expectedHandle !== undefined) {
    assert.equal(completedData.threadHandle === expectedHandle, true);
  }

  return completedData.threadHandle;
}

test(
  "M8 localhost HTTP/SSE: production FRESH then EXISTING turn without replacing Classic",
  { skip: !m8Enabled },
  async () => {
    assert.equal(process.env.THREADWIRE_ACCEPT_DESTRUCTIVE_TESTS, "1");
    assert.equal(process.env.THREADWIRE_ACCEPT_M8_HTTP_SSE, "1");

    const controllerConfig = loadConfig();
    assert.equal(controllerConfig.cdpHost, "127.0.0.1");

    const runtimeProbe = new ClassicSupervisor(controllerConfig);
    const before = await runtimeProbe.inspect();
    assert.equal(before.isRunning, true, "M8 acceptance requires Classic to already be running.");
    if (before.mainProcess === null) {
      throw new Error("M8 acceptance requires a pre-existing Classic Main process.");
    }
    const beforeMain = before.mainProcess;

    const apiPort = controllerConfig.cdpPort === 9224 ? "9225" : "9224";
    const apiConfig = loadApiConfig({
      THREADWIRE_API_HOST: "127.0.0.1",
      THREADWIRE_API_PORT: apiPort,
    });
    assertApiConfigCompatible(apiConfig, controllerConfig);

    const controller = createThreadwireController(controllerConfig);
    const server = new ThreadwireHttpServer(apiConfig, controller, { portOverride: 0 });

    try {
      await server.start();
      const port = server.boundPort;
      assert.notEqual(port, null);
      if (port === null) {
        throw new Error("M8 HTTP server did not expose its loopback port.");
      }

      const healthBefore = await request(port, "GET", "/v1/health");
      assert.equal(healthBefore.statusCode, 200);
      const healthBeforeData = parseJsonRecord(
        healthBefore.body,
        "M8 pre-turn health response was malformed.",
      );
      assert.equal(hasExactKeys(healthBeforeData, ["classic", "cdp"]), true);
      assert.equal(healthBeforeData.classic, "RUNNING");
      assert.equal(healthBeforeData.cdp, "DISCONNECTED");
      assert.equal(healthBefore.body.includes("https://chatgpt.com/c/"), false);

      const freshNonce = nonce();
      const freshInput = `TW_M8_HTTP_IN_${freshNonce}`;
      const freshOutput = `TW_M8_HTTP_OUT_${freshNonce}`;
      const freshPrompt = `Reply with exactly ${freshOutput} and do not repeat ${freshInput}.`;
      const freshResponse = await request(
        port,
        "POST",
        "/v1/turns",
        JSON.stringify({ target: { kind: "FRESH" }, prompt: freshPrompt }),
      );
      const threadHandle = validateTurnSse(
        freshResponse,
        freshInput,
        freshOutput,
        true,
      );

      const threads = await request(port, "GET", "/v1/threads");
      assert.equal(threads.statusCode, 200);
      assert.equal(threads.body.includes("https://chatgpt.com/c/"), false);
      const threadsData = parseJsonRecord(threads.body, "M8 thread list response was malformed.");
      assert.equal(hasExactKeys(threadsData, ["threads"]), true);
      assert.equal(Array.isArray(threadsData.threads), true);
      if (!Array.isArray(threadsData.threads)) {
        throw new Error("M8 thread list did not contain an array.");
      }
      assert.equal(threadsData.threads.length, 1);
      const threadRecord = requireRecord(
        threadsData.threads[0],
        "M8 thread list entry was malformed.",
      );
      assert.equal(hasExactKeys(threadRecord, ["threadHandle"]), true);
      assert.equal(threadRecord.threadHandle === threadHandle, true);

      const existingNonce = nonce();
      const existingInput = `TW_M8_HTTP_IN2_${existingNonce}`;
      const existingOutput = `TW_M8_HTTP_OUT2_${existingNonce}`;
      const existingPrompt = `Reply with exactly ${existingOutput} and do not repeat ${existingInput}.`;
      const existingResponse = await request(
        port,
        "POST",
        "/v1/turns",
        JSON.stringify({
          target: { kind: "THREAD", threadHandle },
          prompt: existingPrompt,
        }),
      );
      validateTurnSse(
        existingResponse,
        existingInput,
        existingOutput,
        false,
        threadHandle,
      );

      const healthAfter = await request(port, "GET", "/v1/health");
      assert.equal(healthAfter.statusCode, 200);
      const healthAfterData = parseJsonRecord(
        healthAfter.body,
        "M8 post-turn health response was malformed.",
      );
      assert.equal(hasExactKeys(healthAfterData, ["classic", "cdp"]), true);
      assert.equal(healthAfterData.classic, "RUNNING");
      assert.equal(healthAfterData.cdp, "CONNECTED");
      assert.equal(healthAfter.body.includes("https://chatgpt.com/c/"), false);
    } finally {
      await server.close().catch(() => undefined);
    }

    const after = await runtimeProbe.inspect();
    assert.equal(after.isRunning, true);
    if (after.mainProcess === null) {
      throw new Error("Classic Main process disappeared during M8 acceptance.");
    }
    assert.equal(sameRuntimeIdentity(identity(beforeMain), identity(after.mainProcess)), true);
    assert.equal(after.generation, before.generation);
  },
);
