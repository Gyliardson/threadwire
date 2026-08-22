import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config/ControllerConfig.js";
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

const m9Enabled =
  process.env.THREADWIRE_ACCEPT_DESTRUCTIVE_TESTS === "1" &&
  process.env.THREADWIRE_ACCEPT_M9_THREAD_PERSISTENCE === "1";

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
      throw new Error("M9 SSE frame did not contain the required event/data fields.");
    }

    let data: unknown;
    try {
      data = JSON.parse(dataLine.slice("data: ".length)) as unknown;
    } catch {
      throw new Error("M9 SSE frame contained malformed JSON data.");
    }

    events.push(
      Object.freeze({
        event: eventLine.slice("event: ".length),
        data,
      }),
    );
  }

  return Object.freeze(events);
}

async function request(
  port: number,
  method: "GET" | "POST",
  path: string,
  body?: string,
): Promise<HttpResponse> {
  return await new Promise<HttpResponse>((resolveRequest, rejectRequest) => {
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
        response.once("error", rejectRequest);
        response.once("end", () => {
          resolveRequest(
            Object.freeze({
              statusCode: response.statusCode ?? 0,
              contentType:
                typeof response.headers["content-type"] === "string"
                  ? response.headers["content-type"]
                  : undefined,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        });
      },
    );
    req.once("error", rejectRequest);
    if (body !== undefined) {
      req.write(body, "utf8");
    }
    req.end();
  });
}

async function reserveLoopbackPort(excludedPort: number): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      const server = net.createServer();
      server.once("error", rejectPort);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          server.close();
          rejectPort(new Error("M9 could not reserve a loopback acceptance port."));
          return;
        }
        const selected = address.port;
        server.close((error) => {
          if (error !== undefined) {
            rejectPort(error);
            return;
          }
          resolvePort(selected);
        });
      });
    });
    if (port !== excludedPort) {
      return port;
    }
  }
  throw new Error("M9 could not reserve an API port distinct from CDP.");
}

function startThreadwireProcess(
  apiPort: number,
  stateDirectory: string,
  cdpHost: string,
  cdpPort: number,
): ChildProcess {
  const entrypoint = resolve(process.cwd(), "dist", "src", "main.js");
  const child = spawn(process.execPath, [entrypoint], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      THREADWIRE_CDP_HOST: cdpHost,
      THREADWIRE_CDP_PORT: String(cdpPort),
      THREADWIRE_API_HOST: "127.0.0.1",
      THREADWIRE_API_PORT: String(apiPort),
      THREADWIRE_STATE_DIR: stateDirectory,
    },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  return child;
}

async function waitForApi(child: ChildProcess, port: number): Promise<HttpResponse> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("M9 Threadwire process exited before the localhost API became ready.");
    }
    try {
      const response = await request(port, "GET", "/v1/health");
      if (response.statusCode === 200) {
        return response;
      }
    } catch {
      // The child may still be binding its localhost listener.
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("M9 Threadwire process did not expose the localhost API before the deadline.");
}

async function stopThreadwireProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await new Promise<void>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error("M9 Threadwire process did not exit before the shutdown deadline."));
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

function validateHealth(response: HttpResponse, expectedCdp: "DISCONNECTED" | "CONNECTED"): void {
  assert.equal(response.statusCode, 200);
  const health = parseJsonRecord(response.body, "M9 health response was malformed.");
  assert.equal(hasExactKeys(health, ["classic", "cdp"]), true);
  assert.equal(health.classic, "RUNNING");
  assert.equal(health.cdp, expectedCdp);
  assert.equal(response.body.includes("https://chatgpt.com/c/"), false);
}

function validateThreadList(response: HttpResponse, expectedHandle: string): void {
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.includes("https://chatgpt.com/c/"), false);
  const body = parseJsonRecord(response.body, "M9 thread list response was malformed.");
  assert.equal(hasExactKeys(body, ["threads"]), true);
  assert.equal(Array.isArray(body.threads), true);
  if (!Array.isArray(body.threads)) {
    throw new Error("M9 thread list did not contain an array.");
  }
  assert.equal(body.threads.length, 1);
  const thread = requireRecord(body.threads[0], "M9 thread list entry was malformed.");
  assert.equal(hasExactKeys(thread, ["threadHandle"]), true);
  assert.equal(thread.threadHandle === expectedHandle, true);
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
  assert.equal(events.length >= 2, true);
  assert.equal(
    events.every((event) => ["TEXT_DELTA", "FINAL_TEXT", "COMPLETED"].includes(event.event)),
    true,
  );

  const deltaEvents = events.filter((event) => event.event === "TEXT_DELTA");
  const finalEvents = events.filter((event) => event.event === "FINAL_TEXT");
  const completedEvents = events.filter((event) => event.event === "COMPLETED");
  assert.equal(finalEvents.length, 1);
  assert.equal(completedEvents.length, 1);
  assert.equal(events.at(-1)?.event, "COMPLETED");
  assert.equal(events.at(-2)?.event, "FINAL_TEXT");

  let deltaText = "";
  for (const event of deltaEvents) {
    const data = requireRecord(event.data, "M9 TEXT_DELTA data was not an object.");
    assert.equal(hasExactKeys(data, ["text"]), true);
    assert.equal(typeof data.text, "string");
    if (typeof data.text === "string") {
      deltaText += data.text;
    }
  }
  assert.equal(deltaText.includes(inputMarker), false);

  const finalData = requireRecord(finalEvents[0]?.data, "M9 FINAL_TEXT data was not an object.");
  assert.equal(hasExactKeys(finalData, ["text"]), true);
  assert.equal(typeof finalData.text, "string");
  if (typeof finalData.text !== "string") {
    throw new Error("M9 FINAL_TEXT text was unavailable.");
  }
  assert.equal(finalData.text.includes(inputMarker), false);
  assert.equal(finalData.text.trim() === outputMarker, true);

  const completedData = requireRecord(
    completedEvents[0]?.data,
    "M9 COMPLETED data was not an object.",
  );
  assert.equal(hasExactKeys(completedData, ["threadHandle", "newlyRegistered"]), true);
  assert.equal(
    typeof completedData.threadHandle === "string" &&
      /^tw_[A-Za-z0-9_-]{1,128}$/.test(completedData.threadHandle),
    true,
  );
  assert.equal(completedData.newlyRegistered, expectedNewlyRegistered);
  if (typeof completedData.threadHandle !== "string") {
    throw new Error("M9 COMPLETED did not contain an opaque ThreadHandle.");
  }
  if (expectedHandle !== undefined) {
    assert.equal(completedData.threadHandle === expectedHandle, true);
  }
  return completedData.threadHandle;
}

test(
  "M9 persists an opaque ThreadHandle across Threadwire process replacement",
  { skip: !m9Enabled },
  async () => {
    assert.equal(process.env.THREADWIRE_ACCEPT_DESTRUCTIVE_TESTS, "1");
    assert.equal(process.env.THREADWIRE_ACCEPT_M9_THREAD_PERSISTENCE, "1");

    const controllerConfig = loadConfig();
    assert.equal(controllerConfig.cdpHost, "127.0.0.1");

    const runtimeProbe = new ClassicSupervisor(controllerConfig);
    const before = await runtimeProbe.inspect();
    assert.equal(before.isRunning, true, "M9 acceptance requires Classic to already be running.");
    if (before.mainProcess === null) {
      throw new Error("M9 acceptance requires a pre-existing Classic Main process.");
    }
    const beforeMain = before.mainProcess;

    const stateDirectory = mkdtempSync(join(tmpdir(), "threadwire-m9-acceptance-"));
    const stateFile = join(stateDirectory, "thread-registry.v1.json");
    let firstProcess: ChildProcess | null = null;
    let secondProcess: ChildProcess | null = null;

    try {
      const firstPort = await reserveLoopbackPort(controllerConfig.cdpPort);
      firstProcess = startThreadwireProcess(
        firstPort,
        stateDirectory,
        controllerConfig.cdpHost,
        controllerConfig.cdpPort,
      );
      validateHealth(await waitForApi(firstProcess, firstPort), "DISCONNECTED");

      const freshNonce = nonce();
      const freshInput = `TW_M9_PERSIST_IN_${freshNonce}`;
      const freshOutput = `TW_M9_PERSIST_OUT_${freshNonce}`;
      const freshPrompt = `Reply with exactly ${freshOutput} and do not repeat ${freshInput}.`;
      const freshResponse = await request(
        firstPort,
        "POST",
        "/v1/turns",
        JSON.stringify({ target: { kind: "FRESH" }, prompt: freshPrompt }),
      );
      const threadHandle = validateTurnSse(freshResponse, freshInput, freshOutput, true);
      validateThreadList(await request(firstPort, "GET", "/v1/threads"), threadHandle);

      const stateStats = statSync(stateFile);
      assert.equal(stateStats.isFile(), true);
      assert.equal(stateStats.size > 0, true);
      assert.equal(stateStats.size <= 1_048_576, true);

      await stopThreadwireProcess(firstProcess);
      firstProcess = null;

      const afterFirstProcess = await runtimeProbe.inspect();
      assert.equal(afterFirstProcess.isRunning, true);
      if (afterFirstProcess.mainProcess === null) {
        throw new Error("Classic Main process disappeared after the first Threadwire process exited.");
      }
      assert.equal(
        sameRuntimeIdentity(identity(beforeMain), identity(afterFirstProcess.mainProcess)),
        true,
      );
      assert.equal(afterFirstProcess.generation, before.generation);

      const secondPort = await reserveLoopbackPort(controllerConfig.cdpPort);
      secondProcess = startThreadwireProcess(
        secondPort,
        stateDirectory,
        controllerConfig.cdpHost,
        controllerConfig.cdpPort,
      );
      validateHealth(await waitForApi(secondProcess, secondPort), "DISCONNECTED");

      // This lookup occurs before the replacement process performs any conversational operation.
      validateThreadList(await request(secondPort, "GET", "/v1/threads"), threadHandle);

      const existingNonce = nonce();
      const existingInput = `TW_M9_PERSIST_IN2_${existingNonce}`;
      const existingOutput = `TW_M9_PERSIST_OUT2_${existingNonce}`;
      const existingPrompt = `Reply with exactly ${existingOutput} and do not repeat ${existingInput}.`;
      const existingResponse = await request(
        secondPort,
        "POST",
        "/v1/turns",
        JSON.stringify({
          target: { kind: "THREAD", threadHandle },
          prompt: existingPrompt,
        }),
      );
      validateTurnSse(existingResponse, existingInput, existingOutput, false, threadHandle);
      validateHealth(await request(secondPort, "GET", "/v1/health"), "CONNECTED");

      await stopThreadwireProcess(secondProcess);
      secondProcess = null;

      const after = await runtimeProbe.inspect();
      assert.equal(after.isRunning, true);
      if (after.mainProcess === null) {
        throw new Error("Classic Main process disappeared during M9 acceptance.");
      }
      assert.equal(sameRuntimeIdentity(identity(beforeMain), identity(after.mainProcess)), true);
      assert.equal(after.generation, before.generation);
    } finally {
      if (firstProcess !== null) {
        await stopThreadwireProcess(firstProcess).catch(() => undefined);
      }
      if (secondProcess !== null) {
        await stopThreadwireProcess(secondProcess).catch(() => undefined);
      }
      rmSync(stateDirectory, { recursive: true, force: true });
    }
  },
);
