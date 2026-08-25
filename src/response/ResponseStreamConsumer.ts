import { TextDecoder } from "node:util";
import { NormalizedResponseStreamEvent } from "./types.js";

const DEFAULT_MAX_ENCODED_CHUNK_CHARS = 1_398_104;
const DEFAULT_MAX_QUEUED_EVENTS = 1024;
const DEFAULT_MAX_QUEUED_TEXT_CHARS = 1_048_576;
const DEFAULT_MAX_PENDING_TEXT_CHARS = 1_048_576;
const DEFAULT_MAX_PENDING_DATA_LINES = 4096;
const ASSISTANT_TEXT_PATCH_PATH = "/message/content/parts/0";
const ASSISTANT_TEXT_PATCH_OPERATION = "append";

export type ResponseStreamConsumerFailureKind = "PARSE_FAILED" | "BUFFER_OVERFLOW";

export class ResponseStreamConsumerError extends Error {
  public constructor(public readonly kind: ResponseStreamConsumerFailureKind) {
    super(
      kind === "BUFFER_OVERFLOW"
        ? "The normalized response event buffer exceeded its bounded capacity."
        : "The response stream could not be normalized safely.",
    );
    this.name = "ResponseStreamConsumerError";
  }
}

export interface ResponseStreamConsumerOptions {
  readonly maxEncodedChunkChars?: number;
  readonly maxQueuedEvents?: number;
  readonly maxQueuedTextChars?: number;
  readonly maxPendingTextChars?: number;
  readonly maxPendingDataLines?: number;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidBase64(value: string): boolean {
  if (value.length === 0) {
    return true;
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }
  const firstPadding = value.indexOf("=");
  return firstPadding === -1 || firstPadding >= value.length - 2;
}

export class ResponseStreamConsumer {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly maxEncodedChunkChars: number;
  private readonly maxQueuedEvents: number;
  private readonly maxQueuedTextChars: number;
  private readonly maxPendingTextChars: number;
  private readonly maxPendingDataLines: number;
  private readonly events: NormalizedResponseStreamEvent[] = [];
  private queuedTextChars = 0;
  private textBuffer = "";
  private eventName: string | null = null;
  private dataLines: string[] = [];
  private pendingDataChars = 0;
  private completedState = false;
  private disposed = false;

  public constructor(options: ResponseStreamConsumerOptions = {}) {
    // Engineering memory-safety limit: roughly 1 MiB of decoded bytes at Base64
    // expansion. This is not an observed or claimed Classic protocol maximum.
    this.maxEncodedChunkChars = positiveSafeInteger(
      options.maxEncodedChunkChars ?? DEFAULT_MAX_ENCODED_CHUNK_CHARS,
      "maxEncodedChunkChars",
    );
    this.maxQueuedEvents = positiveSafeInteger(
      options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS,
      "maxQueuedEvents",
    );
    this.maxQueuedTextChars = positiveSafeInteger(
      options.maxQueuedTextChars ?? DEFAULT_MAX_QUEUED_TEXT_CHARS,
      "maxQueuedTextChars",
    );
    this.maxPendingTextChars = positiveSafeInteger(
      options.maxPendingTextChars ?? DEFAULT_MAX_PENDING_TEXT_CHARS,
      "maxPendingTextChars",
    );
    this.maxPendingDataLines = positiveSafeInteger(
      options.maxPendingDataLines ?? DEFAULT_MAX_PENDING_DATA_LINES,
      "maxPendingDataLines",
    );
  }

  public get completed(): boolean {
    return this.completedState;
  }

  public pushBase64(encoded: string): void {
    if (this.disposed || this.completedState) {
      return;
    }
    if (typeof encoded !== "string") {
      throw new ResponseStreamConsumerError("PARSE_FAILED");
    }
    if (encoded.length > this.maxEncodedChunkChars) {
      throw new ResponseStreamConsumerError("BUFFER_OVERFLOW");
    }
    if (!isValidBase64(encoded)) {
      throw new ResponseStreamConsumerError("PARSE_FAILED");
    }

    let decoded: string;
    try {
      decoded = this.decoder.decode(Buffer.from(encoded, "base64"), { stream: true });
    } catch {
      throw new ResponseStreamConsumerError("PARSE_FAILED");
    }
    this.pushDecoded(decoded);
  }

  public finish(): void {
    if (this.disposed || this.completedState) {
      return;
    }

    let decoded: string;
    try {
      decoded = this.decoder.decode();
    } catch {
      throw new ResponseStreamConsumerError("PARSE_FAILED");
    }
    this.pushDecoded(decoded);

    if (this.textBuffer.length > 0) {
      const line = this.textBuffer.endsWith("\r")
        ? this.textBuffer.slice(0, -1)
        : this.textBuffer;
      this.textBuffer = "";
      this.consumeLine(line);
    }

    this.dispatchRecord();
  }

  public drain(): readonly NormalizedResponseStreamEvent[] {
    if (this.events.length === 0) {
      return Object.freeze([]);
    }
    const drained = this.events.splice(0, this.events.length);
    this.queuedTextChars = 0;
    return Object.freeze(drained);
  }

  public stop(): void {
    this.disposed = true;
    this.textBuffer = "";
    this.eventName = null;
    this.dataLines = [];
    this.pendingDataChars = 0;
  }

  public dispose(): void {
    this.stop();
    this.events.splice(0, this.events.length);
    this.queuedTextChars = 0;
  }

  private pushDecoded(decoded: string): void {
    if (decoded.length === 0 || this.completedState) {
      return;
    }
    this.textBuffer += decoded;
    this.assertPendingTextBound();

    while (!this.completedState) {
      const newlineIndex = this.textBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      let line = this.textBuffer.slice(0, newlineIndex);
      this.textBuffer = this.textBuffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.consumeLine(line);
      this.assertPendingTextBound();
    }
  }

  private consumeLine(line: string): void {
    if (this.completedState) {
      return;
    }
    if (line.length === 0) {
      this.dispatchRecord();
      return;
    }
    if (line.startsWith(":")) {
      return;
    }

    const colonIndex = line.indexOf(":");
    const field = colonIndex < 0 ? line : line.slice(0, colonIndex);
    let value = colonIndex < 0 ? "" : line.slice(colonIndex + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      this.eventName = value;
      this.assertPendingTextBound();
    } else if (field === "data") {
      if (this.dataLines.length >= this.maxPendingDataLines) {
        throw new ResponseStreamConsumerError("BUFFER_OVERFLOW");
      }
      this.pendingDataChars += value.length + (this.dataLines.length === 0 ? 0 : 1);
      this.dataLines.push(value);
      this.assertPendingTextBound();
    }
  }

  private assertPendingTextBound(): void {
    const pending =
      this.textBuffer.length +
      (this.eventName?.length ?? 0) +
      this.pendingDataChars;
    if (pending > this.maxPendingTextChars) {
      throw new ResponseStreamConsumerError("BUFFER_OVERFLOW");
    }
  }

  private dispatchRecord(): void {
    if (this.completedState) {
      this.resetRecord();
      return;
    }
    if (this.dataLines.length === 0) {
      this.resetRecord();
      return;
    }

    const eventName = this.eventName ?? "message";
    const data = this.dataLines.join("\n");
    this.resetRecord();

    if (data === "[DONE]") {
      this.emit(Object.freeze({ type: "COMPLETED" as const }));
      this.completedState = true;
      this.textBuffer = "";
      return;
    }

    if (eventName !== "delta") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new ResponseStreamConsumerError("PARSE_FAILED");
    }

    if (!isObject(parsed) || Object.prototype.hasOwnProperty.call(parsed, "role")) {
      return;
    }
    if (typeof parsed.v === "string") {
      this.emit(Object.freeze({ type: "TEXT_DELTA" as const, text: parsed.v }));
      return;
    }
    if (!Array.isArray(parsed.v)) {
      return;
    }
    for (const patch of parsed.v) {
      if (
        isObject(patch) &&
        patch.p === ASSISTANT_TEXT_PATCH_PATH &&
        patch.o === ASSISTANT_TEXT_PATCH_OPERATION &&
        typeof patch.v === "string"
      ) {
        this.emit(Object.freeze({ type: "TEXT_DELTA" as const, text: patch.v }));
      }
    }
  }

  private emit(event: NormalizedResponseStreamEvent): void {
    if (this.events.length >= this.maxQueuedEvents) {
      throw new ResponseStreamConsumerError("BUFFER_OVERFLOW");
    }
    if (
      event.type === "TEXT_DELTA" &&
      event.text.length > this.maxQueuedTextChars - this.queuedTextChars
    ) {
      throw new ResponseStreamConsumerError("BUFFER_OVERFLOW");
    }
    if (event.type === "TEXT_DELTA") {
      this.queuedTextChars += event.text.length;
    }
    this.events.push(event);
  }

  private resetRecord(): void {
    this.eventName = null;
    this.dataLines = [];
    this.pendingDataChars = 0;
  }
}
