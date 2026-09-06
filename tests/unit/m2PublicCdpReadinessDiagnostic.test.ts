import assert from "node:assert/strict";
import test from "node:test";
import { serializePublicError } from "../../src/api/PublicError.js";
import { CdpSessionManager, CdpTargetDiscoveryLike } from "../../src/cdp/CdpSessionManager.js";
import {
  CdpTransport,
  CdpTransportConnectOptions,
  CdpTransportSession,
} from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import {
  M2PublicCdpReadinessDiagnostic,
  M2PublicCdpReadinessDiagnosticEvent,
  createM2PublicCdpReadinessDiagnosticFromEnvironment,
  wrapM2PublicCdpReadinessDiagnostics,
} from "../../src/diagnostics/M2PublicCdpReadinessDiagnostic.js";
import {
  CdpReadinessFailedError,
  FreshRouteReadinessTimeoutError,
  OperationAbortedError,
  RouteNavigationFailedError,
  RuntimeGenerationChangedError,
  RuntimeProvenanceUnverifiedError,
} from "../../src/domain/errors.js";
import {
  RuntimeGenerationTracker,
  RuntimeLease,
} from "../../src/domain/RuntimeGeneration.js";
import { FreshReadinessPolicy } from "../../src/readiness/FreshReadinessPolicy.js";
import {
  ReadinessController,
  ReadinessDeadlineScheduler,
} from "../../src/readiness/ReadinessController.js";
import {
  ExistingReadinessObservationPort,
  ExistingReadinessSnapshot,
  RouteExpectation,
} from "../../src/readiness/types.js";

const config = { cdpHost: "127.0.0.1" as const, cdpPort: 9223 };
const target: CdpTargetInfo = {
  id: "hostile-target-id-secret",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/hostile-target-id-secret",
  url: "https://chatgpt.com/c/private-thread-locator",
};
const readySnapshot: ExistingReadinessSnapshot = {
  mainFrame: { frameId: "main", loaderId: "loader", expectedRoute: true },
  eligibleEditables: [{ backendDOMNodeId: 101, focused: true }],
  backendActivity: { activeCount: 0, activityEpoch: 1 },
};

class StaticDiscovery implements CdpTargetDiscoveryLike {
  public async findPrimaryTarget(): Promise<CdpTargetInfo> {
    return target;
  }
}

class FakeSession implements CdpTransportSession {
  public initializationFailure: Error | null = null;
  public readinessFailure: Error | null = null;
  public focusFailure: Error | null = null;
  public initializeCalls = 0;
  private readonly listeners = new Set<() => void>();

  public async close(): Promise<void> {}

  public onDisconnect(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async initializeReadinessObservation(): Promise<void> {
    this.initializeCalls += 1;
    if (this.initializationFailure !== null) {
      throw this.initializationFailure;
    }
  }

  public async navigate(_url: string, _signal?: AbortSignal): Promise<void> {}

  public async reload(_signal?: AbortSignal): Promise<void> {}

  public async getReadinessSnapshot(
    _expectedRoute: RouteExpectation,
  ): Promise<ExistingReadinessSnapshot> {
    if (this.readinessFailure !== null) {
      throw this.readinessFailure;
    }
    return readySnapshot;
  }

  public async focusBackendNode(
    _backendDOMNodeId: number,
    _signal?: AbortSignal,
  ): Promise<void> {
    if (this.focusFailure !== null) {
      throw this.focusFailure;
    }
  }
}

class FakeTransport implements CdpTransport {
  public readonly sessions: FakeSession[] = [];
  public configureSession: ((session: FakeSession) => void) | null = null;

  public async connect(_options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    const session = new FakeSession();
    this.configureSession?.(session);
    this.sessions.push(session);
    return session;
  }
}

function createRuntime(): RuntimeGenerationTracker {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 100, creationTime: "runtime-a" });
  return runtime;
}

function createWrappedManager(events: M2PublicCdpReadinessDiagnosticEvent[]) {
  const runtime = createRuntime();
  const transport = new FakeTransport();
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new StaticDiscovery(),
    transport,
    attachTimeoutMs: 50,
  });
  const diagnostic = new M2PublicCdpReadinessDiagnostic((event) => events.push(event));
  return {
    runtime,
    transport,
    wrapped: wrapM2PublicCdpReadinessDiagnostics(manager, diagnostic),
  };
}

test("diagnostic gate is exact and disabled/no-op by default", () => {
  const lines: string[] = [];
  assert.equal(
    createM2PublicCdpReadinessDiagnosticFromEnvironment({}, (line) => lines.push(line)),
    null,
  );
  assert.equal(
    createM2PublicCdpReadinessDiagnosticFromEnvironment(
      { THREADWIRE_M2_PUBLIC_CDP_DIAGNOSTIC: "true" },
      (line) => lines.push(line),
    ),
    null,
  );
  assert.deepEqual(lines, []);
});

test("opt-in payload is closed, bounded, and cannot promote hostile error data", () => {
  const lines: string[] = [];
  const diagnostic = createM2PublicCdpReadinessDiagnosticFromEnvironment(
    { THREADWIRE_M2_PUBLIC_CDP_DIAGNOSTIC: "1" },
    (line) => lines.push(line),
  );
  assert.ok(diagnostic);
  diagnostic.observePrepareMode("CONNECT_OR_RECONNECT");
  const hostile = new Error(
    "token=secret-token https://chatgpt.com/c/private-thread target=hostile-target-id-secret <html>page data</html>",
  );
  hostile.stack = `STACK ${hostile.message}`;
  diagnostic.recordFailure("FRESH_READINESS_SNAPSHOT", hostile);

  assert.equal(lines.length, 1);
  const line = lines[0]!;
  assert.match(line, /^THREADWIRE_M2_PUBLIC_CDP_DIAGNOSTIC_V1 \{/);
  assert.doesNotMatch(line, /secret-token|private-thread|hostile-target-id-secret|<html>|STACK/);
  const payload = JSON.parse(line.slice(line.indexOf("{")).trim()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), [
    "errorClass",
    "operation",
    "outcome",
    "prepareCdpMode",
    "schema",
    "stage",
  ]);
  assert.deepEqual(payload, {
    schema: "M2_PUBLIC_CDP_DIAGNOSTIC_V1",
    operation: "PUBLIC_CDP_READINESS_RCA",
    prepareCdpMode: "CONNECT_OR_RECONNECT",
    stage: "FRESH_READINESS_SNAPSHOT",
    errorClass: "UNEXPECTED_INTERNAL",
    outcome: "FAILURE",
  });

  const failingSink = new M2PublicCdpReadinessDiagnostic(() => {
    throw new Error("sink failure");
  });
  failingSink.observePrepareMode("EXISTING_SESSION");
  assert.doesNotThrow(() =>
    failingSink.recordFailure("FRESH_READINESS_SNAPSHOT", new CdpReadinessFailedError()),
  );
});

test("production proxy discriminates connect/reconnect from an already-usable existing session", async () => {
  const events: M2PublicCdpReadinessDiagnosticEvent[] = [];
  const { runtime, transport, wrapped } = createWrappedManager(events);

  await wrapped.connect();
  const lease = runtime.getCurrentRuntimeLease();
  transport.sessions[0]!.readinessFailure = new Error("first snapshot raw detail");
  await assert.rejects(
    () => wrapped.getReadinessSnapshot({ kind: "FRESH_ROOT" }, lease),
    CdpReadinessFailedError,
  );
  assert.equal(events[0]?.prepareCdpMode, "CONNECT_OR_RECONNECT");

  transport.sessions[0]!.readinessFailure = null;
  await wrapped.connect();
  transport.sessions[0]!.readinessFailure = new Error("second snapshot raw detail");
  await assert.rejects(
    () => wrapped.getReadinessSnapshot({ kind: "FRESH_ROOT" }, lease),
    CdpReadinessFailedError,
  );
  assert.equal(events[1]?.prepareCdpMode, "EXISTING_SESSION");
  assert.equal(transport.sessions[0]!.initializeCalls, 1);
});

test("readiness-init failure is the reconnect/init class and preserves the product error", async () => {
  const events: M2PublicCdpReadinessDiagnosticEvent[] = [];
  const { transport, wrapped } = createWrappedManager(events);
  transport.configureSession = (session) => {
    session.initializationFailure = new Error(
      "raw init secret-token https://chatgpt.com/c/private-thread target=hostile-target-id-secret",
    );
  };

  let observed: unknown;
  try {
    await wrapped.connect();
  } catch (error) {
    observed = error;
  }

  assert.ok(observed instanceof CdpReadinessFailedError);
  assert.equal(serializePublicError(observed).error.code, "CDP_READINESS_FAILED");
  assert.deepEqual(events, [
    {
      schema: "M2_PUBLIC_CDP_DIAGNOSTIC_V1",
      operation: "PUBLIC_CDP_READINESS_RCA",
      prepareCdpMode: "CONNECT_OR_RECONNECT",
      stage: "CDP_PREPARE_READINESS_INIT",
      errorClass: "READINESS_INITIALIZATION_FAILED",
      outcome: "FAILURE",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /secret-token|private-thread|hostile-target-id-secret|raw init/);
});

test("FRESH snapshot and focus failures are distinct and keep CDP readiness semantics", async () => {
  const events: M2PublicCdpReadinessDiagnosticEvent[] = [];
  const { runtime, transport, wrapped } = createWrappedManager(events);
  await wrapped.connect();
  const lease = runtime.getCurrentRuntimeLease();

  transport.sessions[0]!.readinessFailure = new Error("snapshot secret-token");
  await assert.rejects(
    () => wrapped.getReadinessSnapshot({ kind: "FRESH_ROOT" }, lease),
    CdpReadinessFailedError,
  );
  transport.sessions[0]!.readinessFailure = null;
  await wrapped.getReadinessSnapshot({ kind: "FRESH_ROOT" }, lease);
  transport.sessions[0]!.focusFailure = new Error("focus https://chatgpt.com/c/private-thread");
  await assert.rejects(() => wrapped.focusBackendNode(101, lease), CdpReadinessFailedError);

  assert.deepEqual(
    events.map(({ stage, errorClass }) => ({ stage, errorClass })),
    [
      {
        stage: "FRESH_READINESS_SNAPSHOT",
        errorClass: "READINESS_OBSERVATION_FAILED",
      },
      { stage: "FRESH_READINESS_FOCUS", errorClass: "FOCUS_FAILED" },
    ],
  );
  for (const event of events) {
    assert.equal(Object.hasOwn(event, "message"), false);
    assert.equal(Object.hasOwn(event, "cause"), false);
    assert.equal(Object.hasOwn(event, "stack"), false);
  }
  assert.doesNotMatch(JSON.stringify(events), /secret-token|private-thread/);
});

class ClassifiedFailureManager extends CdpSessionManager {
  public constructor(
    private readonly failure:
      | RuntimeProvenanceUnverifiedError
      | RuntimeGenerationChangedError
      | OperationAbortedError,
  ) {
    super(config, createRuntime(), {
      discovery: new StaticDiscovery(),
      transport: new FakeTransport(),
      attachTimeoutMs: 50,
    });
  }

  public override async getReadinessSnapshot(
    _expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<ExistingReadinessSnapshot> {
    throw this.failure;
  }
}

test("provenance/currentness/abort classes are closed and the proxy rethrows the same error object", async () => {
  const cases = [
    {
      failure: new RuntimeProvenanceUnverifiedError("hostile provenance secret-token"),
      stage: "BOUND_RUNTIME_CURRENTNESS",
      errorClass: "PROVENANCE_UNVERIFIED",
    },
    {
      failure: new RuntimeGenerationChangedError("hostile replacement private-thread"),
      stage: "BOUND_RUNTIME_CURRENTNESS",
      errorClass: "RUNTIME_REPLACED",
    },
    {
      failure: new OperationAbortedError("hostile abort target-id"),
      stage: "FRESH_READINESS_SNAPSHOT",
      errorClass: "ABORTED",
    },
  ] as const;

  for (const item of cases) {
    const events: M2PublicCdpReadinessDiagnosticEvent[] = [];
    const diagnostic = new M2PublicCdpReadinessDiagnostic((event) => events.push(event));
    diagnostic.observePrepareMode("EXISTING_SESSION");
    const wrapped = wrapM2PublicCdpReadinessDiagnostics(
      new ClassifiedFailureManager(item.failure),
      diagnostic,
    );
    let observed: unknown;
    try {
      await wrapped.getReadinessSnapshot(
        { kind: "FRESH_ROOT" },
        createRuntime().getCurrentRuntimeLease(),
      );
    } catch (error) {
      observed = error;
    }
    assert.strictEqual(observed, item.failure);
    assert.equal(events[0]?.stage, item.stage);
    assert.equal(events[0]?.errorClass, item.errorClass);
    assert.doesNotMatch(JSON.stringify(events), /secret-token|private-thread|target-id|hostile/);
  }
});

class NeverReadyObservation implements ExistingReadinessObservationPort {
  public async getReadinessSnapshot(
    _expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<ExistingReadinessSnapshot> {
    return {
      mainFrame: { frameId: "main", loaderId: "loader", expectedRoute: false },
      eligibleEditables: [],
      backendActivity: { activeCount: 0, activityEpoch: 0 },
    };
  }

  public async focusBackendNode(
    _backendDOMNodeId: number,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<void> {}
}

test("ordinary FRESH timeout and navigation public error classes are unchanged", async () => {
  const runtime = createRuntime();
  const lease = runtime.getCurrentRuntimeLease();
  let fireDeadline: (() => void) | null = null;
  const scheduler: ReadinessDeadlineScheduler = {
    schedule: (callback) => {
      fireDeadline = callback;
      return 1;
    },
    cancel: () => undefined,
  };
  const controller = new ReadinessController(
    new NeverReadyObservation(),
    undefined,
    new FreshReadinessPolicy({
      frameStableObservations: 1,
      focusStableObservations: 1,
      guardDurationMs: 0,
    }),
    {
      timeoutMs: 10,
      pollIntervalMs: 0,
      sleep: async () => {
        assert.ok(fireDeadline);
        fireDeadline();
      },
      deadlineScheduler: scheduler,
    },
  );

  let observed: unknown;
  try {
    await controller.waitForFreshRoute(lease);
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof FreshRouteReadinessTimeoutError);
  assert.equal(serializePublicError(observed).error.code, "FRESH_ROUTE_READINESS_TIMEOUT");

  const navigation = serializePublicError(new RouteNavigationFailedError());
  assert.equal(navigation.error.code, "ROUTE_NAVIGATION_FAILED");
  assert.equal(navigation.error.message, "Threadwire operation failed.");
  assert.equal(navigation.error.retryable, false);

  const readiness = serializePublicError(new CdpReadinessFailedError());
  assert.equal(readiness.error.code, "CDP_READINESS_FAILED");
  assert.equal(readiness.error.message, "Threadwire operation failed.");
  assert.equal(readiness.error.retryable, false);
  assert.equal(Object.hasOwn(readiness.error, "stage"), false);
  assert.equal(Object.hasOwn(readiness.error, "errorClass"), false);
});
