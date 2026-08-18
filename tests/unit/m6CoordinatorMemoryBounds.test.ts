import assert from "node:assert/strict";
import test from "node:test";
import {
  CdpResponseStreamTracker,
} from "../../src/cdp/CdpResponseStreamTracker.js";
import {
  ExperimentalNetworkDomain,
} from "../../src/cdp/ChromeRemoteInterfaceHelpers.js";
import {
  ResponseStreamConsumer,
  ResponseStreamConsumerError,
} from "../../src/response/ResponseStreamConsumer.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function b64(value: string): string {
  return Buffer.from(value).toString("base64");
}

function delta(text: string): string {
  return `event: delta\ndata: ${JSON.stringify({ v: text })}\n\n`;
}

function assertSanitizedOverflow(error: unknown, canary: string): boolean {
  assert.ok(error instanceof ResponseStreamConsumerError);
  assert.equal(error.kind, "BUFFER_OVERFLOW");
  assert.equal(error.message.includes(canary), false);
  assert.equal(JSON.stringify(error).includes(canary), false);
  return true;
}

test("pending SSE record bounds data-line count even for empty data values", () => {
  const consumer = new ResponseStreamConsumer({
    maxPendingDataLines: 3,
    maxPendingTextChars: 1024,
  });
  const canary = "RAW_RESPONSE_EMPTY_LINE_CANARY";
  assert.throws(
    () => consumer.pushBase64(b64(`data:\ndata:\ndata:\ndata: ${canary}\n`)),
    (error: unknown) => assertSanitizedOverflow(error, canary),
  );
});

test("pending SSE record accounting includes join separator overhead", () => {
  const consumer = new ResponseStreamConsumer({
    maxPendingDataLines: 16,
    maxPendingTextChars: 2,
  });
  assert.throws(
    () => consumer.pushBase64(b64("data:\ndata:\ndata:\ndata:\n")),
    (error: unknown) => {
      assert.ok(error instanceof ResponseStreamConsumerError);
      assert.equal(error.kind, "BUFFER_OVERFLOW");
      return true;
    },
  );
});

test("normalized queued TEXT_DELTA characters have an aggregate bound", () => {
  const consumer = new ResponseStreamConsumer({
    maxQueuedEvents: 16,
    maxQueuedTextChars: 5,
  });
  const canary = "RAW_RESPONSE_NORMALIZED_CANARY";
  consumer.pushBase64(b64(delta("abc")));
  assert.throws(
    () => consumer.pushBase64(b64(delta(canary))),
    (error: unknown) => assertSanitizedOverflow(error, canary),
  );
  assert.deepEqual(consumer.drain(), [{ type: "TEXT_DELTA", text: "abc" }]);
});

test("pending live activation data bounds chunk count independently of base64 characters", async () => {
  const activation = deferred<{ readonly bufferedData?: string }>();
  const network: ExperimentalNetworkDomain = {
    streamResourceContent: async () => await activation.promise,
  };
  const tracker = new CdpResponseStreamTracker(network, true);
  tracker.select("selected");
  tracker.begin("selected");

  const canary = "RAW_PENDING_LIVE_CANARY";
  tracker.onData({ requestId: "selected", data: canary });
  for (let index = 1; index < 1024; index += 1) {
    tracker.onData({ requestId: "selected", data: "" });
  }
  assert.equal(tracker.snapshot().lifecycle, "PENDING");

  tracker.onData({ requestId: "selected", data: "" });
  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot, { lifecycle: "FAILED", failure: "BUFFER_OVERFLOW" });
  assert.equal(JSON.stringify(snapshot).includes(canary), false);

  activation.resolve({ bufferedData: b64(delta("must-not-revive")) });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(tracker.snapshot(), { lifecycle: "FAILED", failure: "BUFFER_OVERFLOW" });
  assert.deepEqual(tracker.drain(), []);
});
