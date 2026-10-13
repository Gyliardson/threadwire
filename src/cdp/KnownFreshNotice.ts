import { CriClient } from "./ChromeRemoteInterfaceHelpers.js";
import { ExistingReadinessSnapshot } from "../readiness/types.js";
import { CdpReadinessFailedError } from "../domain/errors.js";

type AxNode = Awaited<
  ReturnType<CriClient["Accessibility"]["getFullAXTree"]>
>["nodes"][number];
export type BlockingNotice = NonNullable<
  ExistingReadinessSnapshot["blockingNotice"]
>;
const ABSENT: BlockingNotice = Object.freeze({ kind: "ABSENT" });
const UNKNOWN: BlockingNotice = Object.freeze({ kind: "UNKNOWN" });

export function observeBlockingNotice(
  nodes: readonly AxNode[],
): BlockingNotice {
  const dialogs = nodes.filter(
    (n) =>
      !n.ignored &&
      (n.role?.value === "dialog" || n.role?.value === "alertdialog"),
  );
  if (dialogs.length === 0) return ABSENT;
  if (dialogs.length !== 1 || dialogs[0]!.role?.value !== "dialog")
    return UNKNOWN;
  const dialog = dialogs[0]!;
  const map = new Map(nodes.map((n) => [n.nodeId, n]));
  if (map.size !== nodes.length) return UNKNOWN;
  const seen = new Set<string>();
  const subtree: AxNode[] = [];
  const pending = [dialog.nodeId];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) return UNKNOWN;
    seen.add(id);
    const node = map.get(id);
    if (!node) return UNKNOWN;
    subtree.push(node);
    pending.push(...(node.childIds ?? []));
  }
  const visible = subtree.filter((n) => !n.ignored);
  const headings = visible.filter((n) => n.role?.value === "heading");
  const buttons = visible.filter((n) => n.role?.value === "button");
  const close = buttons.filter((n) => n.name?.value === "Fechar");
  if (
    headings.length !== 1 ||
    headings[0]!.name?.value !== "Conheça o novo ChatGPT" ||
    buttons.length !== 2 ||
    close.length !== 1 ||
    buttons.filter((n) => n.name?.value === "Fazer upgrade agora").length !==
      1 ||
    close[0]!.properties?.some(
      (p) => p.name === "disabled" && p.value?.value === true,
    ) ||
    !Number.isSafeInteger(dialog.backendDOMNodeId) ||
    dialog.backendDOMNodeId! <= 0 ||
    !Number.isSafeInteger(close[0]!.backendDOMNodeId) ||
    close[0]!.backendDOMNodeId! <= 0
  )
    return UNKNOWN;
  return Object.freeze({
    kind: "KNOWN_FRESH_NOTICE",
    dialogId: dialog.backendDOMNodeId!,
    closeButtonId: close[0]!.backendDOMNodeId!,
  });
}

export function noticeClickPoint(
  quads: readonly (readonly number[])[],
  width: number,
  height: number,
): { x: number; y: number } {
  const q = quads[0];
  if (
    quads.length !== 1 ||
    q?.length !== 8 ||
    !q.every(Number.isFinite) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  )
    throw new CdpReadinessFailedError();
  const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
  const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
  if (
    Math.max(...xs) - Math.min(...xs) <= 1 ||
    Math.max(...ys) - Math.min(...ys) <= 1 ||
    xs.some((x) => x < 0 || x >= width) ||
    ys.some((y) => y < 0 || y >= height)
  )
    throw new CdpReadinessFailedError();
  const point = {
    x: Math.round(xs.reduce((a, b) => a + b, 0) / 4),
    y: Math.round(ys.reduce((a, b) => a + b, 0) / 4),
  };
  if (point.x < 0 || point.x >= width || point.y < 0 || point.y >= height)
    throw new CdpReadinessFailedError();
  return point;
}

// Internal, pre-input-only discriminator. It never means a dispatched operation
// is retryable, and contains no page content, node IDs or process metadata.
export class ReadinessCandidateChangedError extends CdpReadinessFailedError {
  public constructor() {
    super("Readiness candidate changed before input.");
  }
}

export interface NoticeMouseCommand {
  readonly type: "mousePressed" | "mouseReleased";
  readonly button: "left";
  readonly clickCount: 1;
  readonly x: number;
  readonly y: number;
}
export interface NoticeMouseGuard {
  readonly validate: () => Promise<void>;
  readonly onPossibleInput: () => void;
}
