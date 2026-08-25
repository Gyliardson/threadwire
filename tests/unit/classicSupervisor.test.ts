import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeGeneration, runtimeGenerationNumber } from "../../src/domain/RuntimeGeneration.js";
import { OperationAbortedError } from "../../src/domain/errors.js";
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

function canonicalizeStopCreationTime(creationTime: string): string {
  const match = /^(.*\.\d{6})\d+(Z)$/.exec(creationTime);
  return match ? `${match[1]}${match[2]}` : creationTime;
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
  public readonly stopScripts: string[] = [];

  public constructor(
    private readonly inspector: MutableInspector,
    private readonly replacement: ClassicProcessInfo[],
    private readonly replaceBeforeStop: ClassicProcessInfo[] | null = null,
  ) {}

  public async run(_file: string, _args: readonly string[], options: CommandRunOptions = {}): Promise<{ stdout: string; stderr: string }> {
    const identitiesJson = options.env?.THREADWIRE_CLASSIC_IDENTITIES;
    if (identitiesJson) {
      this.stopIdentityPayloads.push(identitiesJson);
      const stopScript = _args[_args.length - 1];
      if (stopScript) {
        this.stopScripts.push(stopScript);
      }
      if (this.replaceBeforeStop) {
        this.inspector.processes = this.replaceBeforeStop.map((process) => ({ ...process }));
      }

      const expected = JSON.parse(identitiesJson) as Array<{ pid: number; creationTime: string }>;
      const identitiesStillMatch = expected.every((identity) =>
        this.inspector.processes.some(
          (process) =>
            process.pid === identity.pid &&
            canonicalizeStopCreationTime(process.creationTime) ===
              canonicalizeStopCreationTime(identity.creationTime),
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

class AppearingResolver implements ClassicInstallationSource {
  public constructor(private readonly inspector: MutableInspector) {}

  public async resolve(): Promise<{ executablePath: string; packageVersion: string; packageFullName: string }> {
    this.inspector.processes = [main(200, "B")];
    return await new StaticResolver().resolve();
  }
}

class SequenceInspector implements ClassicProcessInspector {
  private index = 0;

  public constructor(private readonly snapshots: readonly (readonly ClassicProcessInfo[])[]) {}

  public async getClassicProcesses(): Promise<ClassicProcessInfo[]> {
    const snapshot = this.snapshots[Math.min(this.index, this.snapshots.length - 1)] ?? [];
    this.index += 1;
    return snapshot.map((process) => ({ ...process }));
  }
}

class GatedFirstInspector extends MutableInspector {
  public calls = 0;
  public readonly entered: Promise<void>;
  public readonly release: () => void;
  private first = true;
  private readonly markEntered: () => void;
  private readonly firstGate: Promise<void>;

  public constructor() {
    super();
    let markEntered!: () => void;
    this.entered = new Promise<void>((resolve) => { markEntered = resolve; });
    this.markEntered = markEntered;
    let release!: () => void;
    this.firstGate = new Promise<void>((resolve) => { release = resolve; });
    this.release = release;
  }

  public override async getClassicProcesses(): Promise<ClassicProcessInfo[]> {
    this.calls += 1;
    if (this.first) {
      this.first = false;
      this.markEntered();
      await this.firstGate;
    }
    return await super.getClassicProcesses();
  }
}

class StopExitedButCommandFailedRunner implements CommandRunner {
  public constructor(
    private readonly inspector: MutableInspector,
    private readonly replacement: ClassicProcessInfo[],
  ) {}

  public async run(_file: string, _args: readonly string[], options: CommandRunOptions = {}): Promise<{ stdout: string; stderr: string }> {
    if (options.env?.THREADWIRE_CLASSIC_IDENTITIES) {
      this.inspector.processes = [];
      throw new Error("synthetic command failure after exit");
    }
    if (options.env?.THREADWIRE_CLASSIC_EXECUTABLE) {
      this.inspector.processes = this.replacement.map((process) => ({ ...process }));
    }
    return { stdout: "", stderr: "" };
  }
}

class StopFailedWithoutExitRunner implements CommandRunner {
  public async run(): Promise<{ stdout: string; stderr: string }> {
    throw new Error("synthetic command failure without exit");
  }
}

class HangingStopRunner implements CommandRunner {
  public aborted = false;

  public async run(_file: string, _args: readonly string[], options: CommandRunOptions = {}): Promise<{ stdout: string; stderr: string }> {
    return await new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        this.aborted = true;
        reject(new Error("synthetic command aborted"));
      }, { once: true });
    });
  }
}

class SuccessfulNoopRunner implements CommandRunner {
  public calls = 0;

  public async run(): Promise<{ stdout: string; stderr: string }> {
    this.calls += 1;
    return { stdout: "", stderr: "" };
  }
}

class SequentialLifecycleRunner implements CommandRunner {
  public launches = 0;

  public constructor(private readonly inspector: MutableInspector) {}

  public async run(_file: string, _args: readonly string[], options: CommandRunOptions = {}): Promise<{ stdout: string; stderr: string }> {
    if (options.env?.THREADWIRE_CLASSIC_IDENTITIES) {
      this.inspector.processes = [];
    }
    if (options.env?.THREADWIRE_CLASSIC_EXECUTABLE) {
      this.launches += 1;
      this.inspector.processes = [main(200 + this.launches, `generation-${this.launches}`)];
    }
    return { stdout: "", stderr: "" };
  }
}

class FailingPollInspector implements ClassicProcessInspector {
  private calls = 0;

  public async getClassicProcesses(): Promise<ClassicProcessInfo[]> {
    this.calls += 1;
    if (this.calls <= 2) {
      return [main(100, "A")];
    }
    throw new Error("synthetic inspection failure");
  }
}

function createSupervisor(
  inspector: MutableInspector,
  replacement: ClassicProcessInfo[],
  runner: CommandRunner = new SupervisorRunner(inspector, replacement),
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

test("stop waits for an in-flight ensureStarted inspection before terminating", async () => {
  const inspector = new GatedFirstInspector();
  inspector.processes = [main(100, "A")];
  const runner = new SupervisorRunner(inspector, [main(200, "B")]);
  const supervisor = createSupervisor(inspector, [main(200, "B")], runner);

  const starting = supervisor.ensureStarted();
  await inspector.entered;
  const stopping = supervisor.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runner.stopIdentityPayloads.length, 0);

  inspector.release();
  await starting;
  await stopping;
  assert.equal(runner.stopIdentityPayloads.length, 1);
  assert.throws(() => supervisor.getCurrentRuntimeLease());
});

test("queued lifecycle abort rejects promptly and skips all stop work", async () => {
  const inspector = new GatedFirstInspector();
  inspector.processes = [main(100, "A")];
  const runner = new SupervisorRunner(inspector, [main(200, "B")]);
  const supervisor = createSupervisor(inspector, [main(200, "B")], runner);
  const starting = supervisor.ensureStarted();
  await inspector.entered;

  const controller = new AbortController();
  const stopping = supervisor.stop(controller.signal);
  controller.abort();
  const outcome = await Promise.race([
    stopping.then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.name : "unknown",
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
  ]);
  inspector.release();
  await starting;
  await assert.rejects(stopping, OperationAbortedError);

  assert.equal(outcome, "OperationAbortedError");
  assert.equal(inspector.calls, 1);
  assert.equal(runner.stopIdentityPayloads.length, 0);
});

test("concurrent restarts serialize complete stop-to-start transitions", async () => {
  const inspector = new MutableInspector();
  inspector.processes = [main(100, "A")];
  const runner = new SequentialLifecycleRunner(inspector);
  const supervisor = new ClassicSupervisor(config, {
    inspector,
    resolver: new StaticResolver(),
    runner,
    processPollIntervalMs: 1,
    processStopTimeoutMs: 50,
    processStartTimeoutMs: 50,
  });
  await supervisor.inspect();

  const generations = await Promise.all([supervisor.restart(), supervisor.restart()]);

  assert.deepEqual(generations.map(runtimeGenerationNumber), [2, 3]);
  assert.equal(runner.launches, 2);
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

test("restart trusts verified process exit when the stop command reports a late failure", async () => {
  const inspector = new MutableInspector();
  inspector.processes = [main(100, "A"), child(101, 100, "A-child")];
  const replacement = [main(200, "B"), child(201, 200, "B-child")];
  const runner = new StopExitedButCommandFailedRunner(inspector, replacement);
  const supervisor = createSupervisor(inspector, replacement, runner);

  await supervisor.inspect();
  const generation = await supervisor.restart();

  assert.equal(runtimeGenerationNumber(generation), 2);
  assert.equal((await supervisor.inspect()).mainProcess?.pid, 200);
});

test("stop remains fail-closed when the command fails and the captured process remains", async () => {
  const inspector = new MutableInspector();
  inspector.processes = [main(100, "A")];
  const supervisor = new ClassicSupervisor(config, {
    inspector,
    resolver: new StaticResolver(),
    runner: new StopFailedWithoutExitRunner(),
    processPollIntervalMs: 1,
    processStopTimeoutMs: 5,
    processStartTimeoutMs: 50,
  });
  await supervisor.inspect();
  const oldLease = supervisor.getCurrentRuntimeLease();

  await assert.rejects(
    supervisor.stop(),
    (error: unknown) => {
      assert.equal(error instanceof Error && error.name, "ClassicStopFailedError");
      return true;
    },
  );
  assert.equal(inspector.processes[0]?.pid, 100);
  assert.throws(() => supervisor.assertRuntimeLeaseCurrent(oldLease));
});

test("stop rejects a replacement observed before the captured process finishes exiting", async () => {
  const original = main(100, "A");
  const replacement = main(200, "B");
  const inspector = new SequenceInspector([
    [original],
    [original],
    [original, replacement],
    [],
  ]);
  const supervisor = new ClassicSupervisor(config, {
    inspector,
    resolver: new StaticResolver(),
    runner: new StopFailedWithoutExitRunner(),
    processPollIntervalMs: 1,
    processStopTimeoutMs: 20,
    processStartTimeoutMs: 50,
  });
  await supervisor.inspect();
  const oldLease = supervisor.getCurrentRuntimeLease();

  await assert.rejects(
    supervisor.stop(),
    (error: unknown) => {
      assert.equal(error instanceof Error && error.name, "ClassicStopFailedError");
      return true;
    },
  );
  assert.throws(() => supervisor.assertRuntimeLeaseCurrent(oldLease));
});

test("stop requires quiescence and rejects a replacement after one empty observation", async () => {
  const inspector = new SequenceInspector([
    [main(100, "A")],
    [],
    [main(200, "B")],
  ]);
  const supervisor = new ClassicSupervisor(config, {
    inspector,
    resolver: new StaticResolver(),
    runner: new StopFailedWithoutExitRunner(),
    processPollIntervalMs: 1,
    processStopTimeoutMs: 20,
    processStartTimeoutMs: 50,
  });

  await assert.rejects(
    supervisor.stop(),
    (error: unknown) => {
      assert.equal(error instanceof Error && error.name, "ClassicStopFailedError");
      return true;
    },
  );
});

test("stop requires consecutive quiescent observations", async () => {
  const original = main(100, "A");
  const inspector = new SequenceInspector([
    [original],
    [],
    [original],
    [],
    [main(200, "B")],
  ]);
  const supervisor = new ClassicSupervisor(config, {
    inspector,
    resolver: new StaticResolver(),
    runner: new StopFailedWithoutExitRunner(),
    processPollIntervalMs: 1,
    processStopTimeoutMs: 20,
    processStartTimeoutMs: 50,
  });

  await assert.rejects(
    supervisor.stop(),
    (error: unknown) => {
      assert.equal(error instanceof Error && error.name, "ClassicStopFailedError");
      return true;
    },
  );
});

test("stop bounds a hung command and remains fail-closed when the process remains", async () => {
  const inspector = new MutableInspector();
  inspector.processes = [main(100, "A")];
  const runner = new HangingStopRunner();
  const supervisor = new ClassicSupervisor(config, {
    inspector,
    resolver: new StaticResolver(),
    runner,
    processPollIntervalMs: 1,
    processStopTimeoutMs: 5,
    processStartTimeoutMs: 50,
  });

  await assert.rejects(
    supervisor.stop(),
    (error: unknown) => {
      assert.equal(error instanceof Error && error.name, "ClassicStopFailedError");
      return true;
    },
  );
  assert.equal(runner.aborted, true);
});

test("stop accepts a timed-out command only after verified process quiescence", async () => {
  const inspector = new MutableInspector();
  inspector.processes = [main(100, "A")];
  const runner = new HangingStopRunner();
  const supervisor = new ClassicSupervisor(config, {
    inspector,
    resolver: new StaticResolver(),
    runner,
    processPollIntervalMs: 1,
    processStopTimeoutMs: 5,
    processStartTimeoutMs: 50,
  });
  await supervisor.inspect();
  const oldLease = supervisor.getCurrentRuntimeLease();
  setTimeout(() => { inspector.processes = []; }, 1);

  await supervisor.stop();

  assert.equal(runner.aborted, true);
  assert.throws(() => supervisor.assertRuntimeLeaseCurrent(oldLease));
});

test("caller abort remains authoritative during a hung stop command", async () => {
  const inspector = new MutableInspector();
  inspector.processes = [main(100, "A")];
  const runner = new HangingStopRunner();
  const supervisor = new ClassicSupervisor(config, {
    inspector,
    resolver: new StaticResolver(),
    runner,
    processPollIntervalMs: 1,
    processStopTimeoutMs: 100,
    processStartTimeoutMs: 50,
  });
  const controller = new AbortController();
  await supervisor.inspect();
  const oldLease = supervisor.getCurrentRuntimeLease();
  const stopping = supervisor.stop(controller.signal);
  setImmediate(() => controller.abort());

  await assert.rejects(stopping, OperationAbortedError);
  assert.equal(runner.aborted, true);
  assert.throws(() => supervisor.assertRuntimeLeaseCurrent(oldLease));
});

test("post-command inspection failure leaves the old runtime lease invalid", async () => {
  const inspector = new FailingPollInspector();
  const supervisor = new ClassicSupervisor(config, {
    inspector,
    resolver: new StaticResolver(),
    runner: new SuccessfulNoopRunner(),
    processPollIntervalMs: 1,
    processStopTimeoutMs: 20,
    processStartTimeoutMs: 50,
  });
  await supervisor.inspect();
  const oldLease = supervisor.getCurrentRuntimeLease();

  await assert.rejects(supervisor.stop(), /synthetic inspection failure/);
  assert.throws(() => supervisor.assertRuntimeLeaseCurrent(oldLease));
});

test("start rejects a runtime that appears after initial inspection but before launch", async () => {
  const inspector = new MutableInspector();
  const runner = new SuccessfulNoopRunner();
  const supervisor = new ClassicSupervisor(config, {
    inspector,
    resolver: new AppearingResolver(inspector),
    runner,
    processPollIntervalMs: 1,
    processStopTimeoutMs: 20,
    processStartTimeoutMs: 20,
  });

  await assert.rejects(
    supervisor.ensureStarted(),
    (error: unknown) => {
      assert.equal(error instanceof Error && error.name, "ClassicStartFailedError");
      return true;
    },
  );
  assert.equal(runner.calls, 0);
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

test("stop accepts creation times that differ only below WMI microsecond precision", async () => {
  const inspector = new MutableInspector();
  const expectedCreationTime = "2026-08-16T15:24:48.9563720Z";
  const actualCreationTime = "2026-08-16T15:24:48.9563724Z";
  inspector.processes = [main(100, expectedCreationTime)];
  const runner = new SupervisorRunner(inspector, [main(200, "B")], [main(100, actualCreationTime)]);
  const supervisor = createSupervisor(inspector, [main(200, "B")], runner);

  await supervisor.stop();

  assert.deepEqual(inspector.processes, []);
  assert.equal(runner.stopIdentityPayloads.length, 1);
  assert.deepEqual(JSON.parse(runner.stopIdentityPayloads[0]!), [
    { pid: 100, creationTime: expectedCreationTime },
  ]);
  assert.equal(runner.stopScripts.length, 1);
  const stopScript = runner.stopScripts[0]!;
  assert.match(
    stopScript,
    /\$actualCanonicalTicks = \[long\]\(\$actualCreationTicks - \(\$actualCreationTicks % 10\)\)/,
  );
  assert.match(stopScript, /\$expectedProcesses = \$env:THREADWIRE_CLASSIC_IDENTITIES \| ConvertFrom-Json -ErrorAction Stop/);
  assert.doesNotMatch(stopScript, /@\(\$env:THREADWIRE_CLASSIC_IDENTITIES/);
  assert.match(
    stopScript,
    /\$expectedCanonicalTicks = \[long\]\(\$expectedCreationTicks - \(\$expectedCreationTicks % 10\)\)/,
  );
  assert.match(stopScript, /if \(\$actualCanonicalTicks -ne \$expectedCanonicalTicks\)/);
  assert.doesNotMatch(stopScript, /if \(\$actualCreationTicks -ne \$expectedCreationTicks\)/);
  assert.ok(
    stopScript.indexOf("$process.Kill()") >
      stopScript.indexOf("if ($actualCanonicalTicks -ne $expectedCanonicalTicks)"),
  );
  assert.match(stopScript, /exit 0\s*$/);
  assert.ok(
    stopScript.indexOf("exit 0") >
      stopScript.indexOf("if ($actualCanonicalTicks -ne $expectedCanonicalTicks) {"),
  );
  assert.ok(
    stopScript.indexOf("exit 0") >
      stopScript.indexOf("$process.Kill()"),
  );
  assert.ok(
    stopScript.indexOf("exit 0") >
      stopScript.indexOf("if (-not $process.HasExited) {"),
  );
});

test("stop fails closed when creation times differ by one complete microsecond", async () => {
  const inspector = new MutableInspector();
  const expectedCreationTime = "2026-08-16T15:24:48.9563720Z";
  const actualCreationTime = "2026-08-16T15:24:48.9563730Z";
  inspector.processes = [main(100, expectedCreationTime)];
  const runner = new SupervisorRunner(inspector, [main(200, "B")], [main(100, actualCreationTime)]);
  const supervisor = createSupervisor(inspector, [main(200, "B")], runner);

  await assert.rejects(
    () => supervisor.stop(),
    (error: unknown) => {
      assert.equal(error instanceof Error && error.name, "ClassicStopFailedError");
      return true;
    },
  );

  assert.equal(inspector.processes.length, 1);
  assert.equal(inspector.processes[0]?.pid, 100);
  assert.equal(inspector.processes[0]?.creationTime, actualCreationTime);
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
