import type { CriClient } from "./ChromeRemoteInterfaceTransport.js";
import {
  CHATGPT_ORIGIN,
  ConversationLocator,
  createConversationLocator,
} from "../domain/ThreadIdentity.js";
import { ReadinessEditableTarget, RouteExpectation } from "../readiness/types.js";

export type { CriClient };
type CriAxNode = Awaited<ReturnType<CriClient["Accessibility"]["getFullAXTree"]>>["nodes"][number];

export type TurnRequestKind = "PREPARE" | "WRITE";

export interface ExperimentalDataReceivedEvent {
  readonly requestId: string;
  readonly data?: string;
}

export interface ExperimentalNetworkDomain {
  streamResourceContent?: (params: Readonly<{ requestId: string }>) => Promise<{
    readonly bufferedData?: string;
  }>;
  dataReceived?: (listener: (event: ExperimentalDataReceivedEvent) => void) => () => unknown;
}

export interface EligibleComposerTarget extends ReadinessEditableTarget {
  readonly empty: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasFunction(value: unknown, name: string): boolean {
  return isObject(value) && typeof value[name] === "function";
}

export function isCriClient(value: unknown): value is CriClient {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.close === "function" &&
    typeof value.on === "function" &&
    hasFunction(value.Page, "navigate") &&
    hasFunction(value.Page, "reload") &&
    hasFunction(value.Page, "getFrameTree") &&
    hasFunction(value.Accessibility, "getFullAXTree") &&
    hasFunction(value.DOM, "focus") &&
    hasFunction(value.Input, "insertText") &&
    hasFunction(value.Input, "dispatchKeyEvent") &&
    hasFunction(value.Network, "enable") &&
    hasFunction(value.Network, "requestWillBeSent") &&
    hasFunction(value.Network, "responseReceived") &&
    hasFunction(value.Network, "loadingFinished") &&
    hasFunction(value.Network, "loadingFailed")
  );
}

function getAxProperty(node: CriAxNode, name: string): unknown {
  return node.properties?.find((property) => property.name === name)?.value.value;
}

function axBoolean(node: CriAxNode, name: string): boolean {
  return getAxProperty(node, name) === true;
}

function isEditableValue(value: unknown): boolean {
  return value === true || value === "plaintext" || value === "richtext";
}

function isKnownEmptyAxValue(value: unknown): boolean {
  return value === undefined || (isObject(value) && value.value === "");
}

export function toEligibleComposer(node: CriAxNode): EligibleComposerTarget | null {
  const backendDOMNodeId = node.backendDOMNodeId;
  if (
    node.ignored ||
    node.role?.value !== "textbox" ||
    !Number.isSafeInteger(backendDOMNodeId) ||
    backendDOMNodeId === undefined ||
    backendDOMNodeId <= 0 ||
    !axBoolean(node, "multiline") ||
    !axBoolean(node, "focusable") ||
    !isEditableValue(getAxProperty(node, "editable")) ||
    axBoolean(node, "disabled") ||
    axBoolean(node, "readonly")
  ) {
    return null;
  }

  return Object.freeze({
    backendDOMNodeId,
    focused: axBoolean(node, "focused"),
    empty: isKnownEmptyAxValue(node.value),
  });
}

export function toReadinessEditable(target: EligibleComposerTarget): ReadinessEditableTarget {
  return Object.freeze({
    backendDOMNodeId: target.backendDOMNodeId,
    focused: target.focused,
  });
}

export function routeMatchesExpected(rawUrl: string, expectedRoute: RouteExpectation): boolean {
  if (expectedRoute.kind === "FRESH_ROOT") {
    try {
      const url = new URL(rawUrl);
      return url.origin === CHATGPT_ORIGIN && url.pathname === "/";
    } catch {
      return false;
    }
  }

  let normalized: ConversationLocator;
  try {
    normalized = createConversationLocator(rawUrl);
  } catch {
    return false;
  }
  return normalized === expectedRoute.locator;
}

export function isRelevantBackendUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === CHATGPT_ORIGIN && url.pathname.startsWith("/backend-api/");
  } catch {
    return false;
  }
}

export function classifyTurnRequest(rawUrl: string, method: string | undefined): TurnRequestKind | null {
  if (method !== "POST") {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    if (url.origin !== CHATGPT_ORIGIN) {
      return null;
    }
    if (url.pathname === "/backend-api/f/conversation/prepare") {
      return "PREPARE";
    }
    if (url.pathname === "/backend-api/f/conversation") {
      return "WRITE";
    }
  } catch {
    return null;
  }

  return null;
}

export function isSuccessfulHttpStatus(status: number): boolean {
  return Number.isFinite(status) && status >= 200 && status < 300;
}
