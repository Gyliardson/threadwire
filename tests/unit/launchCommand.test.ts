import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClassicLaunchInvocation,
  buildClassicWscriptCommandLine,
} from "../../src/runtime/ClassicLaunchCommand.js";

const config = { cdpHost: "127.0.0.1" as const, cdpPort: 9223 };

test("WScript command construction safely quotes paths containing spaces, apostrophes and shell metacharacters", () => {
  const executablePath = "C:\\Program Files\\OpenAI's & Tools;$`\\ChatGPT Classic.exe";
  const commandLine = buildClassicWscriptCommandLine(executablePath, config);
  assert.equal(
    commandLine,
    `"${executablePath}" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223`,
  );
});

test("PowerShell launch source does not interpolate the executable path", () => {
  const executablePath = "C:\\Program Files\\OpenAI's & Tools\\ChatGPT Classic.exe";
  const invocation = buildClassicLaunchInvocation(executablePath, config, {});
  assert.equal(invocation.file, "powershell.exe");
  assert.equal(invocation.options.env?.THREADWIRE_CLASSIC_EXECUTABLE, executablePath);
  assert.equal(invocation.args.some((argument) => argument.includes(executablePath)), false);
});

test("invalid double-quote and newline path inputs are rejected rather than escaped into PowerShell", () => {
  assert.throws(
    () => buildClassicWscriptCommandLine('C:\\Apps\\Bad"Name\\ChatGPT Classic.exe', config),
    TypeError,
  );
  assert.throws(
    () => buildClassicWscriptCommandLine("C:\\Apps\\Bad\nName\\ChatGPT Classic.exe", config),
    TypeError,
  );
});
