import { TextDecoder } from "node:util";
import { ResponseStreamEvent } from "./types.js";

const DEFAULT_MAX_QUEUED_EVENTS = 1024;
const DEFAULT_MAX_PENDING_TEXT_CHARS = 1_048_576;

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
  readonly maxQueuedEvents?: number;
  readonly maxPendingTextChars?: number;
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
  private readonly maxQueuedEvents: number;
  private readonly maxPendingTextChars: number;
  private readonly events: ResponseStreamEvent[] = [];
  private textBuffer = "";
  private eventName: string | null = null;
  private dataLines: string[] = [];
  private completedState = false;
  private disposed = false;

  public constructor(options: ResponseStreamConsumerOptions = {}) {
    this.maxQueuedEvents = positiveSafeInteger(
      options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS,
      "maxQueuedEvents",
    );
    this.maxPendingTextChars = positiveSafeInteger(
      options.maxPendingTextChars ?? DEFAULT_MAX_PENDING_TEXT_CHARS,
      "maxPendingTextChars",
    );
  }

  public get completed(): boolean {
    return this.completedState;
  }

  public pushBase64(encoded: string): void {
    if (this.disposed || this.completedState) {
      return;
    }
    if (typeof encoded !== "string" || !isValidBase64(encoded)) {
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

  public drain(): readonly ResponseStreamEvent[] {
    if (this.events.length === 0) {
      return Object.freeze([]);
    }
    const drained = this.events.splice(0, this.events.length);
    return Object.freeze(drained);
  }

  public stop(): void {
    this.disposed = true;
    this.textBuffer = "";
    this.eventName = null;
    this.dataLines = [];
  }

  public dispose(): void {
    this.stop();
    this.events.splice(0, this.events.length);
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
    } else if (field === "data") {
      this.dataLines.push(value);
      this.assertPendingTextBound();
    }
  }

  private assertPendingTextBound(): void {
    let pending = this.textBuffer.length;
    for (const line of this.dataLines) {
      pending += line.length;
      if (pending > this.maxPendingTextChars) {
        throw new ResponseStreamConsumerError("BUFFER_OVERFLOW");
      }
    }
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
    if (typeof parsed.v !== "string") {
      return;
    }

    this.emit(Object.freeze({ type: "TEXT_DELTA" as const, text: parsed.v }));
  }

  private emit(event: ResponseStreamEvent): void {
    if (this.events.length >= this.maxQueuedEvents) {
      throw new ResponseStreamConsumerError("BUFFER_OVERFLOW");
    }
    this.events.push(event);
  }

  private resetRecord(): void {
    this.eventName = null;
    this.dataLines = [];
  }
}
