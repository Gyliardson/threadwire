import { ConversationLocatorInvalidError } from "./errors.js";
import type { ProjectLocator } from "./ProjectIdentity.js";

export const CHATGPT_ORIGIN = "https://chatgpt.com";

declare const threadHandleBrand: unique symbol;
export type ThreadHandle = string & { readonly [threadHandleBrand]: "ThreadHandle" };

declare const conversationLocatorBrand: unique symbol;
export type ConversationLocator = string & {
  readonly [conversationLocatorBrand]: "ConversationLocator";
};

// M2 supports the observed existing-thread route family only; this is not a universal ChatGPT routing rule.
const EXISTING_CONVERSATION_PATH = /^\/c\/[^/]+\/?$/;
const PROJECT_CONVERSATION_PATH = /^\/g\/(g-p-[A-Za-z0-9_-]+)\/c\/[^/]+\/?$/;
const CANONICAL_PROJECT_COMPONENT = /^g-p-[0-9a-f]{32}$/;
const PROJECT_CONVERSATION_SUFFIX = /^-[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
    !EXISTING_CONVERSATION_PATH.test(url.pathname) &&
      !PROJECT_CONVERSATION_PATH.test(url.pathname)
  ) {
    throw new ConversationLocatorInvalidError();
  }

  const pathname = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return `${CHATGPT_ORIGIN}${pathname}` as ConversationLocator;
}

export function conversationBelongsToProject(
  conversationLocator: ConversationLocator,
  projectLocator: ProjectLocator,
): boolean {
  const conversation = new URL(conversationLocator);
  const project = new URL(projectLocator);
  const projectMatch = /^\/g\/(g-p-[A-Za-z0-9_-]+)\/project$/.exec(project.pathname);
  const conversationMatch = PROJECT_CONVERSATION_PATH.exec(conversation.pathname);
  const projectComponent = projectMatch?.[1];
  const conversationComponent = conversationMatch?.[1];
  if (projectComponent === undefined || conversationComponent === undefined) {
    return false;
  }
  if (conversationComponent === projectComponent) {
    return true;
  }
  return CANONICAL_PROJECT_COMPONENT.test(projectComponent) &&
    conversationComponent.startsWith(projectComponent) &&
    PROJECT_CONVERSATION_SUFFIX.test(conversationComponent.slice(projectComponent.length));
}

export function isUnscopedConversationLocator(locator: ConversationLocator): boolean {
  return EXISTING_CONVERSATION_PATH.test(new URL(locator).pathname);
}

export function createOpaqueThreadHandle(opaqueId: string): ThreadHandle {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(opaqueId)) {
    throw new TypeError("Thread handle factory returned an invalid opaque identifier.");
  }
  return `tw_${opaqueId}` as ThreadHandle;
}
