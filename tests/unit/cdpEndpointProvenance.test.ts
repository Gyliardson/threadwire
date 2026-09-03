import assert from "node:assert/strict";
import test from "node:test";
import {
  RuntimeGenerationTracker,
  RuntimeLease,
} from "../../src/domain/RuntimeGeneration.js";
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
const LATER_CHILD_TIME = "2026-09-02T12:00:02.0000000Z";

type ProcessObservation = Readonly<{
  pid: number;
  parentPid: number;
  creationTime: string;
}>;

function lease(pid = 100, creationTime = MAIN_TIME): RuntimeLease {
  const tracker = new RuntimeGenerationTracker();
  tracker.observe({ pid, creationTime });
  return tracker.getCurrentRuntimeLease();
}

function listener(
  ownerPid: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    listenerCount: 1,
    localAddress: config.cdpHost,
    localPort: config.cdpPort,
    ownerPid,
    ...overrides,
  };
}

function output(
  chainA: readonly ProcessObservation[],
  options: Readonly<{
    chainB?: readonly ProcessObservation[];
    listenerA?: Readonly<Record<string, unknown>>;
    listenerB?: Readonly<Record<string, unknown>>;
  }> = {},
): string {
  const chainB = options.chainB ?? chainA;
  return JSON.stringify({
    listenerA: options.listenerA ?? listener(chainA[0]?.pid ?? 0),
    chainA,
    listenerB: options.listenerB ?? listener(chainB[0]?.pid ?? 0),
    chainB,
  });
}

class SequenceRunner implements CommandRunner {
  public calls = 0;
  public lastFile: string | undefined;
  public lastArgs: readonly string[] | undefined;
  public lastOptions: CommandRunOptions | undefined;

  public constructor(private readonly outputs: readonly string[]) {}

  public async run(
    file: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<{ stdout: string; stderr: string }> {
    this.calls += 1;
    this.lastFile = file;
    this.lastArgs = args;
    this.lastOptions = options;
    const stdout = this.outputs[this.calls - 1];
    if (stdout === undefined) throw new Error("No synthetic provenance output configured.");
    return { stdout, stderr: "" };
  }
}

const mainChain = (): readonly ProcessObservation[] => [
  { pid: 100, parentPid: 1, creationTime: MAIN_TIME },
];
const childChain = (
  pid = 101,
  creationTime = CHILD_TIME,
): readonly ProcessObservation[] => [
  { pid, parentPid: 100, creationTime },
  { pid: 100, parentPid: 1, creationTime: MAIN_TIME },
];

test("listener provenance explicitly binds and later accepts the same owner generation", async () => {
  const sample = output(childChain());
  const runner = new SequenceRunner([sample, sample]);
  const provenance = new WindowsCdpEndpointProvenance(config, runner);
  const expected = lease();

  await provenance.bindOwnedEndpoint(expected);
  await provenance.assertOwnedEndpointCurrent(expected);

  assert.equal(runner.calls, 2);
  assert.equal(runner.lastFile, "powershell.exe");
  assert.deepEqual(runner.lastArgs?.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(runner.lastOptions?.env?.THREADWIRE_CDP_HOST, "127.0.0.1");
  assert.equal(runner.lastOptions?.env?.THREADWIRE_CDP_PORT, "9223");
  assert.equal(runner.lastOptions?.env?.THREADWIRE_CLASSIC_PID, "100");
  assert.equal(runner.lastOptions?.env?.THREADWIRE_CLASSIC_CREATION_TIME, MAIN_TIME);
});

test("listener binding rejects same PID with a new listener-owner creation time", async () => {
  const runner = new SequenceRunner([
    output(childChain(101, CHILD_TIME)),
    output(childChain(101, LATER_CHILD_TIME)),
  ]);
  const provenance = new WindowsCdpEndpointProvenance(config, runner);
  const expected = lease();

  await provenance.bindOwnedEndpoint(expected);
  await assert.rejects(
    provenance.assertOwnedEndpointCurrent(expected),
    RuntimeProvenanceUnverifiedError,
  );
});

test("listener binding rejects a different legitimate descendant owner", async () => {
  const runner = new SequenceRunner([
    output(childChain(101, CHILD_TIME)),
    output(childChain(102, LATER_CHILD_TIME)),
  ]);
  const provenance = new WindowsCdpEndpointProvenance(config, runner);
  const expected = lease();

  await provenance.bindOwnedEndpoint(expected);
  await assert.rejects(
    provenance.assertOwnedEndpointCurrent(expected),
    RuntimeProvenanceUnverifiedError,
  );
});

test("listener provenance rejects a foreign owner outside admitted ancestry", async () => {
  const foreign = [
    { pid: 300, parentPid: 200, creationTime: LATER_CHILD_TIME },
    { pid: 200, parentPid: 1, creationTime: CHILD_TIME },
  ];
  const provenance = new WindowsCdpEndpointProvenance(config, new SequenceRunner([output(foreign)]));
  await assert.rejects(provenance.bindOwnedEndpoint(lease()), RuntimeProvenanceUnverifiedError);
});

test("listener provenance cannot be rebound after admission", async () => {
  const provenance = new WindowsCdpEndpointProvenance(
    config,
    new SequenceRunner([output(mainChain())]),
  );
  const expected = lease();
  await provenance.bindOwnedEndpoint(expected);
  await assert.rejects(provenance.bindOwnedEndpoint(expected), RuntimeProvenanceUnverifiedError);
});

test("listener provenance parser accepts only strictly older parent creation time", () => {
  assert.doesNotThrow(() => parseListenerProvenanceOutput(output(childChain()), config, lease()));

  const equalTime = [
    { pid: 101, parentPid: 100, creationTime: CHILD_TIME },
    { pid: 100, parentPid: 1, creationTime: CHILD_TIME },
  ];
  assert.throws(
    () => parseListenerProvenanceOutput(output(equalTime), config, lease(100, CHILD_TIME)),
    RuntimeProvenanceUnverifiedError,
  );

  const newerParent = [
    { pid: 101, parentPid: 100, creationTime: MAIN_TIME },
    { pid: 100, parentPid: 1, creationTime: CHILD_TIME },
  ];
  assert.throws(
    () => parseListenerProvenanceOutput(output(newerParent), config, lease(100, CHILD_TIME)),
    RuntimeProvenanceUnverifiedError,
  );
});

test("listener provenance parser rejects missing parent, cycles, and parent-reuse ambiguity", () => {
  const broken = [
    { pid: 101, parentPid: 999, creationTime: CHILD_TIME },
    { pid: 100, parentPid: 1, creationTime: MAIN_TIME },
  ];
  assert.throws(
    () => parseListenerProvenanceOutput(output(broken), config, lease()),
    RuntimeProvenanceUnverifiedError,
  );

  const cycle = [
    { pid: 101, parentPid: 100, creationTime: LATER_CHILD_TIME },
    { pid: 100, parentPid: 101, creationTime: CHILD_TIME },
    { pid: 101, parentPid: 1, creationTime: MAIN_TIME },
  ];
  assert.throws(
    () => parseListenerProvenanceOutput(output(cycle), config, lease(101, MAIN_TIME)),
    RuntimeProvenanceUnverifiedError,
  );

  const parentExitReuse = [
    { pid: 101, parentPid: 100, creationTime: LATER_CHILD_TIME },
    { pid: 100, parentPid: 1, creationTime: "2026-09-02T12:00:01.5000000Z" },
  ];
  assert.throws(
    () => parseListenerProvenanceOutput(output(parentExitReuse), config, lease()),
    RuntimeProvenanceUnverifiedError,
  );
});

test("listener provenance parser rejects endpoint absence and ambiguity", () => {
  for (const listenerCount of [0, 2]) {
    assert.throws(
      () => parseListenerProvenanceOutput(
        output(mainChain(), {
          listenerA: listener(100, { listenerCount }),
          listenerB: listener(100, { listenerCount }),
        }),
        config,
        lease(),
      ),
      RuntimeProvenanceUnverifiedError,
    );
  }
});

test("listener provenance parser rejects foreign address and port", () => {
  for (const overrides of [{ localAddress: "127.0.0.2" }, { localPort: 9333 }]) {
    assert.throws(
      () => parseListenerProvenanceOutput(
        output(mainChain(), {
          listenerA: listener(100, overrides),
          listenerB: listener(100, overrides),
        }),
        config,
        lease(),
      ),
      RuntimeProvenanceUnverifiedError,
    );
  }
});

test("listener provenance parser rejects owner changes between listener snapshots", () => {
  assert.throws(
    () => parseListenerProvenanceOutput(
      output(childChain(101, CHILD_TIME), {
        chainB: childChain(102, LATER_CHILD_TIME),
        listenerB: listener(102),
      }),
      config,
      lease(),
    ),
    RuntimeProvenanceUnverifiedError,
  );
});

test("listener provenance parser rejects identity changes during ancestry sampling", () => {
  assert.throws(
    () => parseListenerProvenanceOutput(
      output(childChain(101, CHILD_TIME), {
        chainB: childChain(101, LATER_CHILD_TIME),
      }),
      config,
      lease(),
    ),
    RuntimeProvenanceUnverifiedError,
  );
});

test("listener provenance parser rejects malformed owner and creation observations", () => {
  assert.throws(
    () => parseListenerProvenanceOutput(
      output(mainChain(), {
        listenerA: listener(100, { ownerPid: "100" }),
      }),
      config,
      lease(),
    ),
    RuntimeProvenanceUnverifiedError,
  );
  const malformed = [{ pid: 100, parentPid: 1, creationTime: "not-a-time" }];
  assert.throws(
    () => parseListenerProvenanceOutput(output(malformed), config, lease()),
    RuntimeProvenanceUnverifiedError,
  );
});

test("bound provenance guard explicitly binds then sandwiches current endpoint proof with live runtime observations", async () => {
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
      async bindOwnedEndpoint(actual) {
        assert.equal(actual, expected);
        calls.push("endpoint-bind");
      },
      async assertOwnedEndpointCurrent(actual) {
        assert.equal(actual, expected);
        calls.push("endpoint-current");
      },
    },
  );

  await guard.bind(expected);
  await guard.assertCurrent(expected);

  assert.deepEqual(calls, [
    "runtime",
    "endpoint-bind",
    "runtime",
    "runtime",
    "endpoint-current",
    "runtime",
  ]);
});
