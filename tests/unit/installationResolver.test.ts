import assert from "node:assert/strict";
import test from "node:test";
import {
  ClassicInstallationNotFoundError,
  ClassicInstallationQueryFailedError,
} from "../../src/domain/errors.js";
import {
  ClassicInstallationResolver,
  parseClassicInstallationOutput,
} from "../../src/runtime/ClassicInstallationResolver.js";
import { CommandRunner } from "../../src/runtime/CommandRunner.js";

class StaticRunner implements CommandRunner {
  public constructor(private readonly stdout: string) {}
  public async run(): Promise<{ stdout: string; stderr: string }> {
    return { stdout: this.stdout, stderr: "" };
  }
}

test("installation parsing selects the highest Appx version deterministically", () => {
  const installations = parseClassicInstallationOutput(
    JSON.stringify([
      {
        executablePath: "C:\\Apps\\Old\\ChatGPT Classic.exe",
        packageVersion: "1.2026.100.0",
        packageFullName: "OpenAI.ChatGPT-Desktop_old",
      },
      {
        executablePath: "C:\\Apps\\NewB\\ChatGPT Classic.exe",
        packageVersion: "1.2026.190.0",
        packageFullName: "OpenAI.ChatGPT-Desktop_b",
      },
      {
        executablePath: "C:\\Apps\\NewA\\ChatGPT Classic.exe",
        packageVersion: "1.2026.190.0",
        packageFullName: "OpenAI.ChatGPT-Desktop_a",
      },
    ]),
  );

  assert.equal(installations[0]?.packageFullName, "OpenAI.ChatGPT-Desktop_a");
  assert.equal(installations[1]?.packageFullName, "OpenAI.ChatGPT-Desktop_b");
});

test("installation resolver distinguishes no installation from malformed query output", async () => {
  const missing = new ClassicInstallationResolver(new StaticRunner("[]"));
  await assert.rejects(() => missing.resolve(), ClassicInstallationNotFoundError);

  const malformed = new ClassicInstallationResolver(new StaticRunner('{"executablePath": 5}'));
  await assert.rejects(() => malformed.resolve(), ClassicInstallationQueryFailedError);
});

test("installation parsing rejects non-absolute paths and invalid Appx versions", () => {
  assert.throws(
    () =>
      parseClassicInstallationOutput(
        JSON.stringify([
          {
            executablePath: "ChatGPT Classic.exe",
            packageVersion: "1.2026.190.0",
            packageFullName: "pkg",
          },
        ]),
      ),
    ClassicInstallationQueryFailedError,
  );

  assert.throws(
    () =>
      parseClassicInstallationOutput(
        JSON.stringify([
          {
            executablePath: "C:\\Apps\\ChatGPT Classic.exe",
            packageVersion: "latest",
            packageFullName: "pkg",
          },
        ]),
      ),
    ClassicInstallationQueryFailedError,
  );
});
