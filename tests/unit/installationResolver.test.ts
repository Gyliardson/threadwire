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

class RecordingRunner implements CommandRunner {
  public file: string | undefined;
  public args: readonly string[] | undefined;
  public options: unknown;

  public constructor(
    private readonly stdoutOrError: string | Error,
  ) {}

  public async run(
    file: string,
    args: readonly string[],
    options?: unknown,
  ): Promise<{ stdout: string; stderr: string }> {
    this.file = file;
    this.args = args;
    this.options = options;

    if (this.stdoutOrError instanceof Error) {
      throw this.stdoutOrError;
    }
    return { stdout: this.stdoutOrError, stderr: "" };
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
  const missing = new ClassicInstallationResolver(new RecordingRunner("[]"));
  await assert.rejects(() => missing.resolve(), ClassicInstallationNotFoundError);

  const malformed = new ClassicInstallationResolver(new RecordingRunner('{"executablePath": 5}'));
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

test("installation resolver rejects ambiguous ties for the same Appx version", async () => {
  const ambiguous = new ClassicInstallationResolver(
    new RecordingRunner(
      JSON.stringify([
        {
          executablePath: "C:\\Apps\\app\\ChatGPT Classic.exe",
          packageVersion: "1.2026.190.0",
          packageFullName: "OpenAI.ChatGPT-Desktop_ambiguous",
        },
        {
          executablePath: "C:\\Apps\\backup\\ChatGPT Classic.exe",
          packageVersion: "1.2026.190.0",
          packageFullName: "OpenAI.ChatGPT-Desktop_ambiguous",
        },
      ]),
    ),
  );

  await assert.rejects(
    () => ambiguous.resolve(),
    (error: unknown) => {
      assert.ok(error instanceof ClassicInstallationNotFoundError);
      assert.match(error.message, /Ambiguous installation/);
      return true;
    },
  );
});

test("installation resolver uses fail-closed recursive query semantics", async () => {
  const runner = new RecordingRunner(
    JSON.stringify([
      {
        executablePath: "C:\\Apps\\app\\ChatGPT Classic.exe",
        packageVersion: "1.2026.190.0",
        packageFullName: "OpenAI.ChatGPT-Desktop_test",
      },
    ]),
  );
  const resolver = new ClassicInstallationResolver(runner);
  await resolver.resolve();

  assert.equal(runner.file, "powershell.exe");
  const commandArg = runner.args?.[runner.args.length - 1];
  assert.ok(commandArg);

  assert.match(commandArg, /Get-ChildItem.*-Recurse/);
  assert.match(commandArg, /Get-ChildItem.*-ErrorAction Stop/);
  assert.doesNotMatch(commandArg, /-ErrorAction SilentlyContinue/);
});

test("installation resolver maps subprocess failure to ClassicInstallationQueryFailedError", async () => {
  const failingRunner = new RecordingRunner(new Error("Simulated subprocess failure"));
  const resolver = new ClassicInstallationResolver(failingRunner);

  await assert.rejects(
    () => resolver.resolve(),
    (error: unknown) => {
      assert.ok(error instanceof ClassicInstallationQueryFailedError);
      assert.ok((error as Error).cause instanceof Error);
      assert.equal(((error as Error).cause as Error).message, "Simulated subprocess failure");
      return true;
    },
  );
});
