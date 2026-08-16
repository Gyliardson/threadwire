import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeGeneration, runtimeGenerationNumber } from "../../src/domain/RuntimeGeneration.js";
import { ClassicInstallationSource } from "../../src/runtime/ClassicInstallationResolver.js";
import { ClassicSupervisor } from "../../src/runtime/ClassicSupervisor.js";
import { CommandRunOptions, CommandRunner } from "../../src/runtime/CommandRunner.js";
import { ClassicProcessInfo, ClassicProcessInspector } from "../../src/runtime/ProcessInspector.js";

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
  public readonly stopIdentityPayloads: string[] = [];

  public constructor(
    private readonly inspector: MutableInspector,
    private readonly replacement: ClassicProcessInfo[],
    private readonly replaceBeforeStop: ClassicProcessInfo[] | null = null,
  ) {}

  public async run(_file: string, _args: readonly string[], options: CommandRunOptions = {}): Promise<{ stdout: string; stderr: string }> {
    const identitiesJson = options.env?.THREADWIRE_CLASSIC_IDENTITIES;
    if (identitiesJson) {
      this.stopIdentityPayloads.push(identitiesJson);
      if (this.replaceBeforeStop) {
        this.inspector.processes = this.replaceBeforeStop.map((process) => ({ ...process }));
      }

      const expected = JSON.parse(identitiesJson) as Array<{ pid: number; creationTime: string }>;
      const identitiesStillMatch = expected.every((identity) =>
        this.inspector.processes.some(
          (process) => process.pid === identity.pid && process.creationTime === identity.creationTime,
        ),
      );
      if (!identitiesStillMatch) {
        throw new Error("synthetic Classic process identity mismatch");
      }
      this.inspector.processes = [];
    }
    if (options.env?.THREADWIRE_CLASSIC_EXECUTABLE) {
      this.inspector.processes = this.replacement.map((process) => ({ ...process }));
    }
    return { stdout: "", stderr: "" };
  }
}

function createSupervisor(
  inspector: MutableInspector,
  replacement: ClassicProcessInfo[],
  runner: SupervisorRunner = new SupervisorRunner(inspector, replacement),
): ClassicSupervisor {
  return new ClassicSupervisor(config, {
    inspector,
    resolver: new StaticResolver(),
    runner,
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

test("outward runtime snapshots omit raw Classic command lines", async () => {
  const inspector = new MutableInspector();
  inspector.processes = [
    main(100, "A"),
    {
      ...child(101, 100, "A-child"),
      commandLine: '"ChatGPT Classic.exe" --type=renderer --synthetic-sensitive-argument=do-not-retain',
    },
  ];
  const supervisor = createSupervisor(inspector, [main(200, "B")]);

  const snapshot = await supervisor.inspect();
  assert.deepEqual(Object.keys(snapshot.mainProcess ?? {}).sort(), ["creationTime", "parentPid", "pid", "role"]);
  assert.equal(snapshot.processes.every((process) => !("commandLine" in process)), true);
  assert.equal(JSON.stringify(snapshot).includes("synthetic-sensitive-argument"), false);
});

test("stop fails closed when a captured PID is replaced by a different process identity", async () => {
  const inspector = new MutableInspector();
  inspector.processes = [main(100, "A")];
  const replacementAtSamePid = [main(100, "B")];
  const runner = new SupervisorRunner(inspector, [main(200, "C")], replacementAtSamePid);
  const supervisor = createSupervisor(inspector, [main(200, "C")], runner);

  await supervisor.inspect();
  await assert.rejects(
    () => supervisor.stop(),
    (error: unknown) => {
      assert.equal(error instanceof Error && error.name, "ClassicStopFailedError");
      return true;
    },
  );

  assert.equal(inspector.processes.length, 1);
  assert.equal(inspector.processes[0]?.pid, 100);
  assert.equal(inspector.processes[0]?.creationTime, "B");
  assert.equal(runner.stopIdentityPayloads.length, 1);
  assert.deepEqual(JSON.parse(runner.stopIdentityPayloads[0]!), [{ pid: 100, creationTime: "A" }]);
  assert.equal(runner.stopIdentityPayloads[0]!.includes("commandLine"), false);
});
