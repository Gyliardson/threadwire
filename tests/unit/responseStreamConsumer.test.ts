import assert from "node:assert/strict";
import test from "node:test";
import {
  ResponseStreamConsumer,
  ResponseStreamConsumerError,
} from "../../src/response/ResponseStreamConsumer.js";

function b64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function sse(event: string, data: unknown, eol = "\n"): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${event}${eol}data: ${payload}${eol}${eol}`;
}

test("incremental parser handles SSE records split across base64 byte chunks", () => {
  const consumer = new ResponseStreamConsumer();
  const bytes = Buffer.from(sse("delta", { v: "split" }));
  consumer.pushBase64(bytes.subarray(0, 5).toString("base64"));
  consumer.pushBase64(bytes.subarray(5, 17).toString("base64"));
  consumer.pushBase64(bytes.subarray(17).toString("base64"));
  assert.deepEqual(consumer.drain(), [{ type: "TEXT_DELTA", text: "split" }]);
});

test("multiple SSE records in one chunk preserve accepted delta order", () => {
  const consumer = new ResponseStreamConsumer();
  consumer.pushBase64(
    b64(sse("delta", { v: "A" }) + sse("message", { type: "message_marker" }) + sse("delta", { v: "B" })),
  );
  assert.deepEqual(consumer.drain(), [
    { type: "TEXT_DELTA", text: "A" },
    { type: "TEXT_DELTA", text: "B" },
  ]);
});

test("LF and CRLF framing are accepted", () => {
  const consumer = new ResponseStreamConsumer();
  consumer.pushBase64(b64(sse("delta", { v: "lf" }, "\n") + sse("delta", { v: "crlf" }, "\r\n")));
  assert.deepEqual(consumer.drain(), [
    { type: "TEXT_DELTA", text: "lf" },
    { type: "TEXT_DELTA", text: "crlf" },
  ]);
});

test("base64 payload chunks are decoded and streaming UTF-8 reconstructs split multibyte text", () => {
  const consumer = new ResponseStreamConsumer();
  const bytes = Buffer.from(sse("delta", { v: "A😀B" }), "utf8");
  const emoji = Buffer.from("😀", "utf8");
  const offset = bytes.indexOf(emoji);
  assert.notEqual(offset, -1);
  consumer.pushBase64(bytes.subarray(0, offset + 1).toString("base64"));
  consumer.pushBase64(bytes.subarray(offset + 1, offset + 3).toString("base64"));
  consumer.pushBase64(bytes.subarray(offset + 3).toString("base64"));
  assert.deepEqual(consumer.drain(), [{ type: "TEXT_DELTA", text: "A😀B" }]);
});

test("only delta/no-role/v-string is assistant text; input echoes and metadata stay silent", () => {
  const consumer = new ResponseStreamConsumer();
  const frames = [
    sse("delta", { role: "user", v: "INPUT_ECHO_SECRET" }),
    sse("message", { type: "input_message", content: { parts: ["INPUT_ECHO_SECRET"] } }),
    sse("delta", { role: "system", v: "SYSTEM_SECRET" }),
    sse("delta", { role: "assistant", v: "ASSISTANT_METADATA_SECRET" }),
    sse("message", { type: "title_generation", v: "TITLE_SECRET" }),
    sse("message", { type: "server_ste_metadata", v: "STE_SECRET" }),
    sse("message", { type: "resume_conversation_token", v: "RESUME_SECRET" }),
    sse("message", { type: "message_marker", v: "MARKER_SECRET" }),
    sse("message", { type: "message_stream_complete", v: "COMPLETE_METADATA_SECRET" }),
    sse("message", { type: "conversation_detail_metadata", v: "DETAIL_SECRET" }),
    sse("unknown", { v: "UNKNOWN_V_SECRET" }),
    sse("delta", { v: [{ v: "ARRAY_V_SECRET" }] }),
    sse("message", { content: { parts: ["PARTS_SECRET"] } }),
    sse("delta", { v: "accepted" }),
  ].join("");
  consumer.pushBase64(b64(frames));
  assert.deepEqual(consumer.drain(), [{ type: "TEXT_DELTA", text: "accepted" }]);
});

test("unknown malformed metadata frame is ignored without becoming parser failure", () => {
  const consumer = new ResponseStreamConsumer();
  consumer.pushBase64(b64("event: message\ndata: {not-json\n\n"));
  assert.deepEqual(consumer.drain(), []);
});

test("malformed delta frame fails with sanitized parser error and no raw payload in error graph", () => {
  const consumer = new ResponseStreamConsumer();
  const canary = "RAW_RESPONSE_PAYLOAD_CANARY";
  let thrown: unknown;
  try {
    consumer.pushBase64(b64(`event: delta\ndata: {${canary}\n\n`));
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ResponseStreamConsumerError);
  assert.equal(thrown.kind, "PARSE_FAILED");
  assert.equal(JSON.stringify(thrown).includes(canary), false);
  assert.equal(thrown.message.includes(canary), false);
  assert.equal("cause" in thrown, false);
});

test("exact [DONE] emits COMPLETED once and is never exposed as text", () => {
  const consumer = new ResponseStreamConsumer();
  consumer.pushBase64(b64(sse("delta", { v: "final" }) + "data: [DONE]\n\n" + "data: [DONE]\n\n"));
  assert.deepEqual(consumer.drain(), [
    { type: "TEXT_DELTA", text: "final" },
    { type: "COMPLETED" },
  ]);
  assert.equal(consumer.completed, true);
  consumer.pushBase64(b64(sse("delta", { v: "after-done" })));
  assert.deepEqual(consumer.drain(), []);
});

test("finish rejects incomplete UTF-8 without retaining the raw byte", () => {
  const consumer = new ResponseStreamConsumer();
  consumer.pushBase64(Buffer.from([0xf0]).toString("base64"));
  assert.throws(() => consumer.finish(), (error: unknown) => {
    assert.ok(error instanceof ResponseStreamConsumerError);
    assert.equal(error.kind, "PARSE_FAILED");
    return true;
  });
});

test("pending raw framing and normalized event queues are bounded", () => {
  const raw = new ResponseStreamConsumer({ maxPendingTextChars: 8 });
  assert.throws(() => raw.pushBase64(b64("123456789")), (error: unknown) => {
    assert.ok(error instanceof ResponseStreamConsumerError);
    assert.equal(error.kind, "BUFFER_OVERFLOW");
    return true;
  });

  const events = new ResponseStreamConsumer({ maxQueuedEvents: 1 });
  assert.throws(
    () => events.pushBase64(b64(sse("delta", { v: "a" }) + sse("delta", { v: "b" }))),
    (error: unknown) => {
      assert.ok(error instanceof ResponseStreamConsumerError);
      assert.equal(error.kind, "BUFFER_OVERFLOW");
      return true;
    },
  );
});
