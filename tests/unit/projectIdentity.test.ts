import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpaqueProjectHandle,
  createProjectLocator,
  createProjectName,
} from "../../src/domain/ProjectIdentity.js";
import { ProjectLocatorInvalidError } from "../../src/domain/errors.js";

test("project names accept bounded normalized visible text", () => {
  assert.equal(createProjectName("Threadwire Acceptance"), "Threadwire Acceptance");
  assert.equal(createProjectName("設計計画"), "設計計画");
});

test("project names reject empty, padded, non-normalized, controlled, and oversized values", () => {
  for (const value of ["", " padded", "padded ", "line\nbreak", "e\u0301", "x".repeat(101)]) {
    assert.throws(() => createProjectName(value));
  }
});

test("project locator accepts only the observed exact ChatGPT project route", () => {
  const locator = createProjectLocator("https://chatgpt.com/g/g-p-synthetic_123/project");
  assert.equal(locator, "https://chatgpt.com/g/g-p-synthetic_123/project");
  for (const value of [
    "http://chatgpt.com/g/g-p-synthetic/project",
    "https://example.com/g/g-p-synthetic/project",
    "https://chatgpt.com/g/g-p-synthetic/project?secret=1",
    "https://chatgpt.com/g/g-p-synthetic/project#fragment",
    "https://chatgpt.com/g/g-p-synthetic/files",
  ]) {
    assert.throws(() => createProjectLocator(value), ProjectLocatorInvalidError);
  }
});

test("project handles are opaque and independent from locators", () => {
  const handle = createOpaqueProjectHandle("synthetic-id");
  assert.equal(handle, "prj_synthetic-id");
  assert.equal(handle.includes("chatgpt.com"), false);
});
