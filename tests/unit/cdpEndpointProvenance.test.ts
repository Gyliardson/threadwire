import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeGeneration, RuntimeLease } from "../../src/domain/RuntimeGeneration.js";
import { RuntimeProvenanceUnverifiedError } from "../../src/domain/errors.js";
import { BoundRuntimeProvenanceGuard } from "../../src/runtime/BoundRuntimeProvenanceGuard.js";
import {
  WindowsCdpEndpointProvenance,
  parseListenerProvenanceOutput,
} from "../../src/runtime/CdpEndpointProvenance.js";
import { CommandRunOptions, CommandRunner } from "../../src/runtime/CommandRunner.js";

const config = { cdpHost: "127.0.0.1" as const, cdpPort: 9223 };
const MAIN_TIME = "2026-09-02T12:00:00.0000000Z";
const CHILD_TIME = "2026-09-02T12:00:01.0000000Z";

function lease(pid = 100, creationTime = MAIN_TIME): RuntimeLease {
  return Object.freeze({
    generation: 1 as RuntimeGeneration,
    identity: Object.freeze({ pid, creationTime }),
  });
}

function output(
  chain: readonly Readonly<{ pid: number; parentPid: number; creationTime: string }>[],
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    listenerCount: 1,
    localAddress: config.cdpHost,
    localPort: config.cdpPort,
    ownerPid: chain[0]?.pid,
    chain,
    ...overrides,
  });
}

class StaticRunner implements CommandRunner {
  public calls = 0;
  public lastFile: string | undefined;
  public lastArgs: readonly string[] | undefined;
  public lastOptions: CommandRunOptions | undefined;

  public constructor(public stdout: string) {}

  public async run(
    file: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<{ stdout: string; stderr: string }> {
    this.calls += 1;
    this.lastFile = file;
    this.lastArgs = args;
    this.lastOptions = options;
    return { stdout: this.stdout, stderr: "" };
  }
}

test("listener provenance accepts the admitted Classic main as listener owner", async () => {
  const runner = new StaticRunner(output([{ pid: 100, parentPid: 1, creationTime: MAIN_TIME }]));
  const provenance = new WindowsCdpEndpointProvenance(config, runner);

  await provenance.assertOwnedByRuntime(lease());

  assert.equal(runner.calls, 1);
  assert.equal(runner.lastFile, "powershell.exe");
  assert.deepEqual(runner.lastArgs?.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(runner.lastOptions?.env?.THREADWIRE_CDP_HOST, "127.0.0.1");
  assert.equal(runner.lastOptions?.env?.THREADWIRE_CDP_PORT, "9223");
  assert.equal(runner.lastOptions?.env?.THREADWIRE_CLASSIC_PID, "100");
  assert.equal(runner.lastOptions?.env?.THREADWIRE_CLASSIC_CREATION_TIME, MAIN_TIME);
});

test("listener provenance accepts a freshly observed descendant chain to the admitted main", async () => {
  const runner = new StaticRunner(output([
    { pid: 101, parentPid: 100, creationTime: CHILD_TIME },
    { pid: 100, parentPid: 1, creationTime: MAIN_TIME },
  ]));
  const provenance = new WindowsCdpEndpointProvenance(config, runner);

  await provenance.assertOwnedByRuntime(lease());
});

test("listener provenance rejects an owner outside the admitted runtime ancestry", async () => {
  const runner = new StaticRunner(output([
    { pid: 300, parentPid: 200, creationTime: CHILD_TIME },
    { pid: 200, parentPid: 1, creationTime: MAIN_TIME },
  ]));
  const provenance = new WindowsCdpEndpointProvenance(config, runner);

  await assert.rejects(provenance.assertOwnedByRuntime(lease()), RuntimeProvenanceUnverifiedError);
});

test("listener provenance rejects pid reuse when admitted creationTime does not match", async () => {
  const runner = new StaticRunner(output([
    { pid: 101, parentPid: 100, creationTime: CHILD_TIME },
    { pid: 100, parentPid: 1, creationTime: "2026-09-02T12:00:00.5000000Z" },
  ]));
  const provenance = new WindowsCdpEndpointProvenance(config, runner);

  await assert.rejects(provenance.assertOwnedByRuntime(lease()), RuntimeProvenanceUnverifiedError);
});

test("listener provenance parser rejects endpoint substitution and listener ambiguity", () => {
  const chain = [{ pid: 100, parentPid: 1, creationTime: MAIN_TIME }];
  for (const overrides of [
    { localAddress: "127.0.0.2" },
    { localPort: 9333 },
    { listenerCount: 0 },
    { listenerCount: 2 },
  ]) {
    assert.throws(
      () => parseListenerProvenanceOutput(output(chain, overrides), config, lease()),
      RuntimeProvenanceUnverifiedError,
    );
  }
});

test("listener provenance parser rejects malformed identity observations", () => {
  assert.throws(
    () => parseListenerProvenanceOutput(
      output([{ pid: 100, parentPid: 1, creationTime: MAIN_TIME }], { ownerPid: "100" }),
      config,
      lease(),
    ),
    RuntimeProvenanceUnverifiedError,
  );
  assert.throws(
    () => parseListenerProvenanceOutput(
      output([{ pid: 100, parentPid: 1, creationTime: "not-a-time" }]),
      config,
      lease(),
    ),
    RuntimeProvenanceUnverifiedError,
  );
});

test("listener provenance parser rejects broken parent links and PID-reuse creation ordering", () => {
  assert.throws(
    () => parseListenerProvenanceOutput(output([
      { pid: 101, parentPid: 999, creationTime: CHILD_TIME },
      { pid: 100, parentPid: 1, creationTime: MAIN_TIME },
    ]), config, lease()),
    RuntimeProvenanceUnverifiedError,
  );
  assert.throws(
    () => parseListenerProvenanceOutput(output([
      { pid: 101, parentPid: 100, creationTime: MAIN_TIME },
      { pid: 100, parentPid: 1, creationTime: CHILD_TIME },
    ]), config, lease()),
    RuntimeProvenanceUnverifiedError,
  );
});

test("bound provenance guard sandwiches endpoint proof with live runtime observations", async () => {
  const calls: string[] = [];
  const expected = lease();
  const guard = new BoundRuntimeProvenanceGuard(
    {
      getCurrentRuntimeLease: () => expected,
      assertRuntimeLeaseCurrent: () => undefined,
      async assertRuntimeLeaseCurrentObserved(actual) {
        assert.equal(actual, expected);
        calls.push("runtime");
      },
    },
    {
      async assertOwnedByRuntime(actual) {
        assert.equal(actual, expected);
        calls.push("endpoint");
      },
    },
  );

  await guard.assertCurrent(expected);

  assert.deepEqual(calls, ["runtime", "endpoint", "runtime"]);
});
