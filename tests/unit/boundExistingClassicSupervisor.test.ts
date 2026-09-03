import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeLease } from "../../src/domain/RuntimeGeneration.js";
import {
  ClassicProcessTopologyError,
  RequiredExistingRuntimeError,
  RuntimeGenerationChangedError,
} from "../../src/domain/errors.js";
import { ClassicInstallationSource } from "../../src/runtime/ClassicInstallationResolver.js";
import { ClassicSupervisor } from "../../src/runtime/ClassicSupervisor.js";
import { CommandRunner } from "../../src/runtime/CommandRunner.js";
import { ClassicProcessInfo, ClassicProcessInspector } from "../../src/runtime/ProcessInspector.js";

const config = { cdpHost: "127.0.0.1" as const, cdpPort: 9223 };

function main(pid: number, creationTime: string): ClassicProcessInfo {
  return { pid, parentPid: 1, commandLine: '"ChatGPT Classic.exe"', creationTime, role: "MAIN" };
}

class MutableInspector implements ClassicProcessInspector {
  public processes: ClassicProcessInfo[] = [];
  public calls = 0;
  public async getClassicProcesses(): Promise<ClassicProcessInfo[]> {
    this.calls += 1;
    return this.processes.map((process) => ({ ...process }));
  }
}

class CountingResolver implements ClassicInstallationSource {
  public calls = 0;
  public async resolve(): Promise<{ executablePath: string; packageVersion: string; packageFullName: string }> {
    this.calls += 1;
    return { executablePath: "C:\\synthetic\\ChatGPT Classic.exe", packageVersion: "synthetic", packageFullName: "synthetic" };
  }
}

class CountingRunner implements CommandRunner {
  public calls = 0;
  public async run(): Promise<{ stdout: string; stderr: string }> {
    this.calls += 1;
    return { stdout: "", stderr: "" };
  }
}

function fixture() {
  const inspector = new MutableInspector();
  const resolver = new CountingResolver();
  const runner = new CountingRunner();
  const supervisor = new ClassicSupervisor(config, { inspector, resolver, runner });
  return { inspector, resolver, runner, supervisor };
}

function generation(lease: RuntimeLease): number {
  return lease.generation as unknown as number;
}

test("requireExisting binds exactly one pre-existing Classic without lifecycle authority", async () => {
  const f = fixture();
  f.inspector.processes = [main(100, "2026-09-02T12:00:00.0000000Z")];
  const lease = await f.supervisor.requireExisting();
  assert.equal(lease.identity.pid, 100);
  assert.equal(generation(lease), 1);
  assert.equal(f.resolver.calls, 0);
  assert.equal(f.runner.calls, 0);
});

test("requireExisting rejects a missing Classic with zero resolver and launch calls", async () => {
  const f = fixture();
  await assert.rejects(f.supervisor.requireExisting(), RequiredExistingRuntimeError);
  assert.equal(f.resolver.calls, 0);
  assert.equal(f.runner.calls, 0);
});

test("requireExisting rejects ambiguous Classic topology", async () => {
  const f = fixture();
  f.inspector.processes = [main(100, "2026-09-02T12:00:00.0000000Z"), main(200, "2026-09-02T12:00:01.0000000Z")];
  await assert.rejects(f.supervisor.requireExisting(), ClassicProcessTopologyError);
  assert.equal(f.resolver.calls, 0);
  assert.equal(f.runner.calls, 0);
});

test("observed lease assertion detects exit even when tracker still holds the lease", async () => {
  const f = fixture();
  f.inspector.processes = [main(100, "2026-09-02T12:00:00.0000000Z")];
  const lease = await f.supervisor.requireExisting();
  f.supervisor.assertRuntimeLeaseCurrent(lease);
  f.inspector.processes = [];
  await assert.rejects(f.supervisor.assertRuntimeLeaseCurrentObserved(lease), RuntimeGenerationChangedError);
});

test("observed lease assertion rejects replacement generation without adopting it as expected", async () => {
  const f = fixture();
  f.inspector.processes = [main(100, "2026-09-02T12:00:00.0000000Z")];
  const lease = await f.supervisor.requireExisting();
  f.inspector.processes = [main(200, "2026-09-02T12:00:01.0000000Z")];
  await assert.rejects(f.supervisor.assertRuntimeLeaseCurrentObserved(lease), RuntimeGenerationChangedError);
  await assert.rejects(f.supervisor.assertRuntimeLeaseCurrentObserved(lease), RuntimeGenerationChangedError);
  assert.equal(f.resolver.calls, 0);
  assert.equal(f.runner.calls, 0);
});

test("observed lease assertion accepts the same pid plus creationTime identity", async () => {
  const f = fixture();
  f.inspector.processes = [main(100, "2026-09-02T12:00:00.0000000Z")];
  const lease = await f.supervisor.requireExisting();
  await f.supervisor.assertRuntimeLeaseCurrentObserved(lease);
  f.supervisor.assertRuntimeLeaseCurrent(lease);
  assert.equal(generation(lease), 1);
});

test("observed lease assertion rejects same pid with a different creationTime", async () => {
  const f = fixture();
  f.inspector.processes = [main(100, "2026-09-02T12:00:00.0000000Z")];
  const lease = await f.supervisor.requireExisting();
  f.inspector.processes = [main(100, "2026-09-02T12:00:01.0000000Z")];
  await assert.rejects(f.supervisor.assertRuntimeLeaseCurrentObserved(lease), RuntimeGenerationChangedError);
});
