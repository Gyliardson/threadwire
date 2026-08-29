import { ConversationLocatorInvalidError } from "./errors.js";

export const CHATGPT_ORIGIN = "https://chatgpt.com";

declare const threadHandleBrand: unique symbol;
export type ThreadHandle = string & { readonly [threadHandleBrand]: "ThreadHandle" };

declare const conversationLocatorBrand: unique symbol;
export type ConversationLocator = string & {
  readonly [conversationLocatorBrand]: "ConversationLocator";
};

// M2 supports the observed existing-thread route family only; this is not a universal ChatGPT routing rule.
const EXISTING_CONVERSATION_PATH = /^\/c\/[^/]+\/?$/;
const THREAD_HANDLE = /^tw_[A-Za-z0-9_-]{1,128}$/;

export function createConversationLocator(value: string): ConversationLocator {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ConversationLocatorInvalidError(undefined, { cause: error });
  }

  if (
    url.protocol !== "https:" ||
    url.origin !== CHATGPT_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    !EXISTING_CONVERSATION_PATH.test(url.pathname)
  ) {
    throw new ConversationLocatorInvalidError();
  }

  const pathname = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return `${CHATGPT_ORIGIN}${pathname}` as ConversationLocator;
}

export function createThreadHandle(value: string): ThreadHandle {
  if (!THREAD_HANDLE.test(value)) {
    throw new TypeError("Thread handle is invalid.");
  }
  return value as ThreadHandle;
}

export function createOpaqueThreadHandle(opaqueId: string): ThreadHandle {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(opaqueId)) {
    throw new TypeError("Thread handle factory returned an invalid opaque identifier.");
  }
  return createThreadHandle(`tw_${opaqueId}`);
}
