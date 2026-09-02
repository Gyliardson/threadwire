import assert from "node:assert/strict";
import test from "node:test";
import { serializePublicError } from "../../src/api/PublicError.js";
import {
  RequiredExistingRuntimeError,
  RuntimeGenerationChangedError,
  RuntimeProvenanceUnverifiedError,
  RuntimeRecoveryForbiddenError,
} from "../../src/domain/errors.js";

const sensitiveValues = [
  "pid=4242",
  "2026-09-02T12:34:56.1234567Z",
  "generation=17",
  "ownerPid=5151",
  "parentPid=6161",
  "target-synthetic-secret",
  "ws://127.0.0.1:9223/devtools/page/target-synthetic-secret",
  "C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT-Desktop\\ChatGPT Classic.exe",
  "--synthetic-sensitive-command-line",
  "https://chatgpt.com/c/synthetic-private-locator",
] as const;

const sensitiveMessage = sensitiveValues.join(" | ");

function assertSanitized(error: Error): void {
  const serialized = JSON.stringify(serializePublicError(error));
  for (const value of sensitiveValues) {
    assert.equal(serialized.includes(value), false, `public error leaked ${value}`);
  }
  assert.equal(serialized.includes(sensitiveMessage), false);
}

test("bound-existing domain errors discard process, CDP, executable, and locator metadata at the public seam", () => {
  const cause = new Error(sensitiveMessage);
  for (const error of [
    new RequiredExistingRuntimeError(sensitiveMessage, { cause }),
    new RuntimeGenerationChangedError(sensitiveMessage, { cause }),
    new RuntimeProvenanceUnverifiedError(sensitiveMessage, { cause }),
    new RuntimeRecoveryForbiddenError(sensitiveMessage, { cause }),
  ]) {
    assertSanitized(error);
  }
});

test("bound-existing public errors remain non-retryable", () => {
  for (const error of [
    new RequiredExistingRuntimeError(),
    new RuntimeGenerationChangedError(),
    new RuntimeProvenanceUnverifiedError(),
    new RuntimeRecoveryForbiddenError(),
  ]) {
    assert.equal(serializePublicError(error).error.retryable, false);
  }
});
