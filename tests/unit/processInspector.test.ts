import assert from "node:assert/strict";
import test from "node:test";
import { ClassicProcessTopologyError, ProcessInspectionFailedError } from "../../src/domain/errors.js";
import { CommandRunner } from "../../src/runtime/CommandRunner.js";
import {
  parseClassicProcessOutput,
  ProcessInspector,
  selectUniqueMainProcess,
} from "../../src/runtime/ProcessInspector.js";

class StaticRunner implements CommandRunner {
  public constructor(private readonly result: { stdout?: string; error?: Error }) {}

  public async run(): Promise<{ stdout: string; stderr: string }> {
    if (this.result.error) {
      throw this.result.error;
    }
    return { stdout: this.result.stdout ?? "[]", stderr: "" };
  }
}

const mainRecord = {
  pid: 100,
  parentPid: 50,
  commandLine: '"C:\\Program Files\\WindowsApps\\ChatGPT Classic.exe"',
  creationTime: "2026-08-16T12:00:00.0000000Z",
};

test("process parsing distinguishes Main from children using command line and process ancestry", () => {
  const processes = parseClassicProcessOutput(
    JSON.stringify([
      mainRecord,
      {
        pid: 101,
        parentPid: 100,
        commandLine: '"ChatGPT Classic.exe" --type=renderer',
        creationTime: "2026-08-16T12:00:00.1000000Z",
      },
      {
        pid: 102,
        parentPid: 100,
        commandLine: null,
        creationTime: "2026-08-16T12:00:00.2000000Z",
      },
    ]),
  );

  assert.equal(processes[0]?.role, "MAIN");
  assert.equal(processes[1]?.role, "CHILD");
  assert.equal(processes[2]?.role, "CHILD");
  assert.equal(selectUniqueMainProcess(processes)?.pid, 100);
});

test("successful process inspection with zero processes remains distinct from inspection failure", async () => {
  const emptyInspector = new ProcessInspector(new StaticRunner({ stdout: "[]" }));
  assert.deepEqual(await emptyInspector.getClassicProcesses(), []);

  const failedInspector = new ProcessInspector(new StaticRunner({ error: new Error("synthetic failure") }));
  await assert.rejects(() => failedInspector.getClassicProcesses(), ProcessInspectionFailedError);
});

test("malformed process JSON is an inspection failure, not an empty process set", async () => {
  const inspector = new ProcessInspector(new StaticRunner({ stdout: "not-json" }));
  await assert.rejects(() => inspector.getClassicProcesses(), ProcessInspectionFailedError);
});

test("ambiguous or child-only process topology is rejected", () => {
  const twoMains = parseClassicProcessOutput(
    JSON.stringify([
      mainRecord,
      { ...mainRecord, pid: 200, creationTime: "2026-08-16T12:00:01.0000000Z" },
    ]),
  );
  assert.throws(() => selectUniqueMainProcess(twoMains), ClassicProcessTopologyError);

  const childOnly = parseClassicProcessOutput(
    JSON.stringify([
      {
        pid: 101,
        parentPid: 1,
        commandLine: '"ChatGPT Classic.exe" --type=renderer',
        creationTime: "2026-08-16T12:00:00.1000000Z",
      },
    ]),
  );
  assert.throws(() => selectUniqueMainProcess(childOnly), ClassicProcessTopologyError);
});
