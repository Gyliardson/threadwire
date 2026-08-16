import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeGeneration, runtimeGenerationNumber } from "../../src/domain/RuntimeGeneration.js";
import { ClassicProcessInfo } from "../../src/domain/RuntimeState.js";
import { ClassicInstallationSource } from "../../src/runtime/ClassicInstallationResolver.js";
import { ClassicSupervisor } from "../../src/runtime/ClassicSupervisor.js";
import { CommandRunOptions, CommandRunner } from "../../src/runtime/CommandRunner.js";
import { ClassicProcessInspector } from "../../src/runtime/ProcessInspector.js";

const config = { cdpHost: "127.0.0.1" as const, cdpPort: 9223 };

function main(pid: number, creationTime: string): ClassicProcessInfo {
  return { pid, parentPid: 1, commandLine: '"ChatGPT Classic.exe"', creationTime, role: "MAIN" };
}

function child(pid: number, parentPid: number, creationTime: string): ClassicProcessInfo {
  return {
    pid,
    parentPid,
    commandLine: '"ChatGPT Classic.exe" --type=renderer',
    creationTime,
    role: "CHILD",
  };
}

class MutableInspector implements ClassicProcessInspector {
  public processes: ClassicProcessInfo[] = [];
  public async getClassicProcesses(): Promise<ClassicProcessInfo[]> {
    return this.processes.map((process) => ({ ...process }));
  }
}

class StaticResolver implements ClassicInstallationSource {
  public async resolve(): Promise<{ executablePath: string; packageVersion: string; packageFullName: string }> {
    return {
      executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT-Desktop\\ChatGPT Classic.exe",
      packageVersion: "1.2026.190.0",
      packageFullName: "OpenAI.ChatGPT-Desktop_test",
    };
  }
}

class SupervisorRunner implements CommandRunner {
  public constructor(
    private readonly inspector: MutableInspector,
    private readonly replacement: ClassicProcessInfo[],
  ) {}

  public async run(_file: string, _args: readonly string[], options: CommandRunOptions = {}): Promise<{ stdout: string; stderr: string }> {
    if (options.env?.THREADWIRE_CLASSIC_PIDS) {
      this.inspector.processes = [];
    }
    if (options.env?.THREADWIRE_CLASSIC_EXECUTABLE) {
      this.inspector.processes = this.replacement.map((process) => ({ ...process }));
    }
    return { stdout: "", stderr: "" };
  }
}

function createSupervisor(inspector: MutableInspector, replacement: ClassicProcessInfo[]): ClassicSupervisor {
  return new ClassicSupervisor(config, {
    inspector,
    resolver: new StaticResolver(),
    runner: new SupervisorRunner(inspector, replacement),
    processPollIntervalMs: 1,
    processStopTimeoutMs: 50,
    processStartTimeoutMs: 50,
  });
}

test("ensureStarted binds an already-running Main without advancing for child churn", async () => {
  const inspector = new MutableInspector();
  inspector.processes = [main(100, "A"), child(101, 100, "A-child-1")];
  const supervisor = createSupervisor(inspector, [main(200, "B")]);

  const first = await supervisor.ensureStarted();
  assert.equal(runtimeGenerationNumber(first), 1);

  inspector.processes = [main(100, "A"), child(102, 100, "A-child-2")];
  const second = await supervisor.inspect();
  assert.equal(runtimeGenerationNumber(second.generation), 1);
});

test("restart verifies the prior process set exits and advances exactly once for the new Main identity", async () => {
  const inspector = new MutableInspector();
  inspector.processes = [main(100, "A"), child(101, 100, "A-child")];
  const replacement = [main(200, "B"), child(201, 200, "B-child")];
  const supervisor = createSupervisor(inspector, replacement);

  const before = await supervisor.inspect();
  assert.equal(runtimeGenerationNumber(before.generation), 1);

  const afterGeneration = await supervisor.restart();
  assert.equal(runtimeGenerationNumber(afterGeneration), 2);
  const after = await supervisor.inspect();
  assert.equal(after.mainProcess?.pid, 200);
  assert.equal(after.processes.some((process) => process.pid === 100 || process.pid === 101), false);
  assert.equal(runtimeGenerationNumber(after.generation), 2);
});

test("a RuntimeLease issued before restart becomes stale after replacement", async () => {
  const inspector = new MutableInspector();
  inspector.processes = [main(100, "A")];
  const supervisor = createSupervisor(inspector, [main(200, "B")]);
  await supervisor.inspect();
  const oldLease = supervisor.getCurrentRuntimeLease();

  const generation: RuntimeGeneration = await supervisor.restart();
  assert.equal(runtimeGenerationNumber(generation), 2);
  assert.throws(() => supervisor.assertRuntimeLeaseCurrent(oldLease));
});
