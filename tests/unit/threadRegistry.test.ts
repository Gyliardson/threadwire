import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationBelongsToProject,
  createConversationLocator,
  ThreadHandle,
} from "../../src/domain/ThreadIdentity.js";
import { createProjectLocator } from "../../src/domain/ProjectIdentity.js";
import {
  ConversationLocatorInvalidError,
  ThreadHandleCollisionError,
  ThreadNotFoundError,
} from "../../src/domain/errors.js";
import {
  DEFAULT_THREAD_HANDLE_COLLISION_ATTEMPTS,
  ThreadRegistry,
} from "../../src/routing/ThreadRegistry.js";

function sequenceFactory(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `fallback-${index}`;
}

test("register returns opaque deterministic handles and normalizes duplicate locators", () => {
  const registry = new ThreadRegistry({ handleFactory: sequenceFactory("handle-a", "handle-b") });
  const first = createConversationLocator("https://chatgpt.com/c/synthetic-conversation-a/?view=1#fragment");
  const same = createConversationLocator("https://CHATGPT.com/c/synthetic-conversation-a");

  const handleA = registry.register(first);
  const handleAgain = registry.register(same);

  assert.equal(handleA, "tw_handle-a");
  assert.equal(handleAgain, handleA);
  assert.equal(handleA.includes("synthetic-conversation-a"), false);
  assert.equal(registry.resolve(handleA), "https://chatgpt.com/c/synthetic-conversation-a");
});

test("distinct locators receive distinct handles and knownThreads exposes handles only", () => {
  const registry = new ThreadRegistry({ handleFactory: sequenceFactory("one", "two") });
  const first = registry.register(createConversationLocator("https://chatgpt.com/c/synthetic-a"));
  const second = registry.register(createConversationLocator("https://chatgpt.com/c/synthetic-b"));

  assert.notEqual(first, second);
  const known = registry.knownThreads();
  assert.deepEqual(known, [first, second]);
  const serialized = JSON.stringify(known);
  assert.equal(serialized.includes("synthetic-a"), false);
  assert.equal(serialized.includes("synthetic-b"), false);
  assert.throws(() => (known as ThreadHandle[]).push("tw_mutation" as ThreadHandle), TypeError);
  assert.deepEqual(registry.knownThreads(), [first, second]);
});

test("provisional registrations stay private and promote the same opaque handle", async () => {
  const registry = new ThreadRegistry({ handleFactory: sequenceFactory("provisional") });
  const locator = createConversationLocator("https://chatgpt.com/c/synthetic-provisional");

  const registration = registry.reserveProvisionalWithStatus(locator);
  assert.equal(registration.created, true);
  if (!registration.created) assert.fail("Expected a new provisional registration.");
  assert.deepEqual(registry.knownThreads(), []);
  assert.throws(() => registry.resolve(registration.threadHandle), ThreadNotFoundError);

  let waiterSettled = false;
  const waiter = registry.waitForCommit(registration.threadHandle).then(() => {
    waiterSettled = true;
  });
  await Promise.resolve();
  assert.equal(waiterSettled, false);

  assert.equal(registry.commitProvisional(registration.transaction), true);
  await waiter;
  assert.equal(registry.resolve(registration.threadHandle), locator);
  assert.deepEqual(registry.knownThreads(), [registration.threadHandle]);
});

test("provisional rollback rejects waiters without exposing locator data", async () => {
  const registry = new ThreadRegistry({ handleFactory: sequenceFactory("rolled-back") });
  const locator = createConversationLocator("https://chatgpt.com/c/PROVISIONAL_LOCATOR_CANARY");
  const registration = registry.reserveProvisionalWithStatus(locator);
  if (!registration.created) assert.fail("Expected a new provisional registration.");
  const waiter = registry.waitForCommit(registration.threadHandle);

  assert.equal(registry.rollbackProvisional(registration.transaction), true);
  await assert.rejects(
    waiter,
    (error: unknown) =>
      error instanceof ThreadNotFoundError &&
      !error.message.includes("PROVISIONAL_LOCATOR_CANARY"),
  );
  assert.deepEqual(registry.knownThreads(), []);
  assert.throws(() => registry.resolve(registration.threadHandle), ThreadNotFoundError);
});

test("provisional duplicate status cannot roll back a pre-existing registration", () => {
  const registry = new ThreadRegistry({ handleFactory: sequenceFactory("committed", "unused") });
  const locator = createConversationLocator("https://chatgpt.com/c/synthetic-existing");
  const committedHandle = registry.register(locator);

  const duplicate = registry.reserveProvisionalWithStatus(locator);
  assert.deepEqual(duplicate, { threadHandle: committedHandle, created: false });
  assert.equal(registry.resolve(committedHandle), locator);
  assert.deepEqual(registry.knownThreads(), [committedHandle]);
});

test("unknown handles fail with a stable Threadwire error without locator metadata", () => {
  const registry = new ThreadRegistry({ handleFactory: sequenceFactory("known") });
  registry.register(createConversationLocator("https://chatgpt.com/c/synthetic-known"));

  assert.throws(
    () => registry.resolve("tw_unknown" as ThreadHandle),
    (error: unknown) =>
      error instanceof ThreadNotFoundError &&
      error.code === "THREAD_NOT_FOUND" &&
      !error.message.includes("synthetic-known"),
  );
});

test("conversation locator validation enforces the explicit MVP existing-route contract", () => {
  const invalid = [
    "http://chatgpt.com/c/synthetic-a",
    "https://example.com/c/synthetic-a",
    "https://user:pass@chatgpt.com/c/synthetic-a",
    "https://chatgpt.com/",
    "https://chatgpt.com/c/",
    "https://chatgpt.com/c/synthetic-a/extra",
    "not a url",
  ];

  for (const value of invalid) {
    assert.throws(() => createConversationLocator(value), ConversationLocatorInvalidError);
  }
});

test("project-qualified conversation locators are supported with exact ownership checks", () => {
  const project = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000030/project");
  const owned = createConversationLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000030/c/conversation-a");
  const foreign = createConversationLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000031/c/conversation-b");

  assert.equal(conversationBelongsToProject(owned, project), true);
  assert.equal(conversationBelongsToProject(foreign, project), false);
  assert.equal(
    createConversationLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000030/c/conversation-a?private=discarded"),
    owned,
  );
});

test("observed Project conversation suffixes preserve exact canonical ownership", () => {
  const projectId = "g-p-0123456789abcdef0123456789abcdef";
  const project = createProjectLocator(`https://chatgpt.com/g/${projectId}/project`);
  const owned = createConversationLocator(
    `https://chatgpt.com/g/${projectId}-synthetic-workspace/c/conversation-a`,
  );
  const ambiguousPrefix = createConversationLocator(
    `https://chatgpt.com/g/${projectId}f/c/conversation-b`,
  );

  assert.equal(conversationBelongsToProject(owned, project), true);
  assert.equal(conversationBelongsToProject(ambiguousPrefix, project), false);
});

test("handle collision retries are bounded and fail closed", () => {
  let calls = 0;
  const registry = new ThreadRegistry({
    handleFactory: () => {
      calls += 1;
      return "collision";
    },
  });

  registry.register(createConversationLocator("https://chatgpt.com/c/synthetic-first"));
  assert.throws(
    () => registry.register(createConversationLocator("https://chatgpt.com/c/synthetic-second")),
    ThreadHandleCollisionError,
  );
  assert.equal(calls, 1 + DEFAULT_THREAD_HANDLE_COLLISION_ATTEMPTS);
  assert.equal(registry.knownThreads().length, 1);
});
