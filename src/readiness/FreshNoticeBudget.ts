import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { userInfo } from "node:os";
import { RuntimeLease } from "../domain/RuntimeGeneration.js";
import { CdpReadinessFailedError } from "../domain/errors.js";

export const FRESH_NOTICE_INTENT_SCHEMA =
  "THREADWIRE_KNOWN_FRESH_NOTICE_INTENT_V1";
export const NOTICE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface NoticeDocument {
  readonly frameId: string;
  readonly loaderId: string;
}
export interface FreshNoticeConsumption {
  consume(lease: RuntimeLease, document: NoticeDocument): void;
}
export function freshNoticeLedgerRoot(): string {
  return join(userInfo().homedir, ".threadwire", "fresh-notice-intents");
}
function reject(): never {
  throw new CdpReadinessFailedError("Known-notice authority is unavailable.");
}
function assertNoLinks(path: string): void {
  let current = resolve(path);
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) reject();
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

// Production always uses the fixed OS-user ledger namespace, keyed by UUID rather
// than a caller-selected filename. A directory override is only an injected test seam.
export class FreshNoticeBudget implements FreshNoticeConsumption {
  private readonly intentPath: string;
  private readonly consumedPath: string;
  private readonly bytes: Buffer;
  private readonly authority: string;
  private readonly rootPid: number;
  private readonly rootCreationTime: string;
  private spent = false;

  public constructor(
    private readonly intent: string,
    ledgerRoot = freshNoticeLedgerRoot(),
  ) {
    if (!NOTICE_UUID.test(intent)) reject();
    this.intentPath = join(resolve(ledgerRoot), `${intent}.json`);
    this.consumedPath = join(resolve(ledgerRoot), `${intent}.consumed.json`);
    assertNoLinks(this.intentPath);
    if (!lstatSync(this.intentPath).isFile()) reject();
    this.bytes = readFileSync(this.intentPath);
    if (this.bytes.length === 0 || this.bytes.length > 4096) reject();
    const record: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(this.bytes),
    );
    if (record === null || typeof record !== "object" || Array.isArray(record))
      reject();
    const value = record as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !==
        "authority,intent,rootCreationTime,rootPid,schema,scope" ||
      value.schema !== FRESH_NOTICE_INTENT_SCHEMA ||
      value.intent !== intent ||
      typeof value.authority !== "string" ||
      !NOTICE_UUID.test(value.authority) ||
      value.scope !== "DISMISS_KNOWN_FRESH_NOTICE_ONCE" ||
      typeof value.rootPid !== "number" ||
      !Number.isSafeInteger(value.rootPid) ||
      value.rootPid < 1 ||
      typeof value.rootCreationTime !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/.test(value.rootCreationTime)
    )
      reject();
    this.authority = value.authority;
    this.rootPid = value.rootPid;
    this.rootCreationTime = value.rootCreationTime;
    if (existsSync(this.consumedPath)) this.spent = true;
  }

  public consume(lease: RuntimeLease, document: NoticeDocument): void {
    if (
      this.spent ||
      lease.identity.pid !== this.rootPid ||
      lease.identity.creationTime !== this.rootCreationTime ||
      !document.frameId ||
      !document.loaderId ||
      document.frameId.length > 256 ||
      document.loaderId.length > 256
    )
      reject();
    assertNoLinks(this.intentPath);
    if (!readFileSync(this.intentPath).equals(this.bytes)) reject();
    // Set the in-memory latch before attempting persistence; any failure stops this
    // candidate. The exclusive durable UUID record prevents replay after restart.
    this.spent = true;
    const fd = openSync(this.consumedPath, "wx", 0o600);
    try {
      const record = JSON.stringify({
        schema: FRESH_NOTICE_INTENT_SCHEMA,
        intent: this.intent,
        authority: this.authority,
        state: "CONSUMED_NONREPLAYABLE",
        consumedUtc: new Date().toISOString(),
        authoritySha256: createHash("sha256").update(this.bytes).digest("hex"),
        runtimeLease: lease,
        document,
      });
      writeSync(fd, `${record}\n`, null, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
