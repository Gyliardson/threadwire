import assert from "node:assert/strict";
import test from "node:test";
import { serializePublicError } from "../../src/api/PublicError.js";
import { BoundCdpSessionManager } from "../../src/cdp/BoundCdpSessionManager.js";
import { CdpSessionManager, CdpTargetDiscoveryLike } from "../../src/cdp/CdpSessionManager.js";
import {
  CdpTransport,
  CdpTransportConnectOptions,
  CdpTransportSession,
} from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { ThreadwireController } from "../../src/controller/ThreadwireController.js";
import {
  M2PublicCdpReadinessDiagnostic,
  M2PublicCdpReadinessDiagnosticEvent,
  createM2PublicCdpReadinessDiagnosticFromEnvironment,
  createThreadwireControllerWithM2PublicCdpDiagnostic,
  wrapM2PublicCdpReadinessDiagnostics,
} from "../../src/diagnostics/M2PublicCdpReadinessDiagnostic.js";
import {
  CdpDisconnectedError,
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
import { RuntimeProvenanceGuard } from "../../src/runtime/BoundRuntimeProvenanceGuard.js";

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
const unfocusedSnapshot: ExistingReadinessSnapshot = {
  ...readySnapshot,
  eligibleEditables: [{ backendDOMNodeId: 101, focused: false }],
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
  public readinessSnapshot: ExistingReadinessSnapshot = readySnapshot;
  public initializeCalls = 0;
  public closeCalls = 0;
  public focusCalls = 0;
  private readonly listeners = new Set<() => void>();

  public async close(): Promise<void> {
    this.closeCalls += 1;
  }

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
    return this.readinessSnapshot;
  }

  public async focusBackendNode(
    _backendDOMNodeId: number,
    _signal?: AbortSignal,
  ): Promise<void> {
    this.focusCalls += 1;
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

class FakeProvenanceGuard implements RuntimeProvenanceGuard {
  public failure: Error | null = null;
  public bindCalls = 0;
  public assertCalls = 0;

  public async bind(_expectedLease: RuntimeLease, _signal?: AbortSignal): Promise<void> {
    this.bindCalls += 1;
    if (this.failure !== null) {
      throw this.failure;
    }
  }

  public async assertCurrent(_expectedLease: RuntimeLease, _signal?: AbortSignal): Promise<void> {
    this.assertCalls += 1;
    if (this.failure !== null) {
      throw this.failure;
    }
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

function fastFreshController(observation: ExistingReadinessObservationPort): ReadinessController {
  return new ReadinessController(
    observation,
    undefined,
    new FreshReadinessPolicy({
      frameStableObservations: 1,
      focusStableObservations: 1,
      guardDurationMs: 0,
    }),
    { timeoutMs: 100, pollIntervalMs: 0, sleep: async () => undefined },
  );
}

test("disabled/default bootstrap uses the normal controller path and exact opt-in selects diagnostics", () => {
  const normalController = Object.freeze({}) as unknown as ThreadwireController;
  const diagnosticController = Object.freeze({}) as unknown as ThreadwireController;
  let normalCalls = 0;
  let diagnosticCalls = 0;
  const factories = {
    createNormal: () => {
      normalCalls += 1;
      return normalController;
    },
    createDiagnostic: () => {
      diagnosticCalls += 1;
      return diagnosticController;
    },
  };

  assert.strictEqual(
    createThreadwireControllerWithM2PublicCdpDiagnostic(config, {}, factories),
    normalController,
  );
  assert.strictEqual(
    createThreadwireControllerWithM2PublicCdpDiagnostic(
      config,
      { THREADWIRE_M2_PUBLIC_CDP_DIAGNOSTIC: "true" },
      factories,
    ),
    normalController,
  );
  assert.strictEqual(
    createThreadwireControllerWithM2PublicCdpDiagnostic(
      config,
      { THREADWIRE_M2_PUBLIC_CDP_DIAGNOSTIC: "1" },
      factories,
    ),
    diagnosticController,
  );
  assert.equal(normalCalls, 2);
  assert.equal(diagnosticCalls, 1);

  const lines: string[] = [];
  assert.equal(
    createM2PublicCdpReadinessDiagnosticFromEnvironment({}, (line) => lines.push(line)),
    null,
  );
  assert.deepEqual(lines, []);
});

test("opt-in payload is six closed fields and cannot promote hostile error data", () => {
  const lines: string[] = [];
  const diagnostic = createM2PublicCdpReadinessDiagnosticFromEnvironment(
    { THREADWIRE_M2_PUBLIC_CDP_DIAGNOSTIC: "1" },
    (line) => lines.push(line),
  );
  assert.ok(diagnostic);
  diagnostic.observePrepareMode("RECONNECT_ATTEMPTED");

  const hostileCause = new Error(
    "cause token=secret-token https://chatgpt.com/c/private-thread target=hostile-target-id-secret <html>page data</html>",
  );
  hostileCause.stack = `STACK ${hostileCause.message}`;
  const hostile = new CdpReadinessFailedError(
    "message token=second-secret https://chatgpt.com/c/private-thread",
    { cause: hostileCause },
  );
  diagnostic.recordFailure("FRESH_READINESS_SNAPSHOT", hostile);

  assert.equal(lines.length, 1);
  const line = lines[0]!;
  assert.match(line, /^THREADWIRE_M2_PUBLIC_CDP_DIAGNOSTIC_V1 \{/);
  assert.doesNotMatch(
    line,
    /secret-token|second-secret|private-thread|hostile-target-id-secret|<html>|STACK/,
  );
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
    prepareCdpMode: "RECONNECT_ATTEMPTED",
    stage: "FRESH_READINESS_SNAPSHOT",
    errorClass: "READINESS_OBSERVATION_FAILED",
    outcome: "FAILURE",
  });
});

test("REUSED_CONNECTED is emitted only after a genuinely idempotent connected preparation", async () => {
  const events: M2PublicCdpReadinessDiagnosticEvent[] = [];
  const { runtime, transport, wrapped } = createWrappedManager(events);

  await wrapped.connect();
  await wrapped.connect();
  const lease = runtime.getCurrentRuntimeLease();
  transport.sessions[0]!.readinessFailure = new Error("snapshot raw detail");

  await assert.rejects(
    () => wrapped.getReadinessSnapshot({ kind: "FRESH_ROOT" }, lease),
    CdpReadinessFailedError,
  );

  assert.equal(transport.sessions.length, 1);
  assert.equal(transport.sessions[0]!.initializeCalls, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.prepareCdpMode, "REUSED_CONNECTED");
});

test("RECONNECT_ATTEMPTED is emitted only after replacement preparation actually runs", async () => {
  const events: M2PublicCdpReadinessDiagnosticEvent[] = [];
  const { runtime, transport, wrapped } = createWrappedManager(events);

  await wrapped.connect();
  await wrapped.disconnect();
  await wrapped.connect();
  const lease = runtime.getCurrentRuntimeLease();
  transport.sessions[1]!.readinessFailure = new Error("snapshot raw detail");

  await assert.rejects(
    () => wrapped.getReadinessSnapshot({ kind: "FRESH_ROOT" }, lease),
    CdpReadinessFailedError,
  );

  assert.equal(transport.sessions.length, 2);
  assert.equal(transport.sessions[0]!.closeCalls, 1);
  assert.equal(transport.sessions[1]!.initializeCalls, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.prepareCdpMode, "RECONNECT_ATTEMPTED");
});

test("reconnect readiness-init failure is distinct and preserves public CDP readiness behavior", async () => {
  const events: M2PublicCdpReadinessDiagnosticEvent[] = [];
  const { transport, wrapped } = createWrappedManager(events);

  await wrapped.connect();
  await wrapped.disconnect();
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
      prepareCdpMode: "RECONNECT_ATTEMPTED",
      stage: "RECONNECT_READINESS_INIT",
      errorClass: "READINESS_INITIALIZATION_FAILED",
      outcome: "FAILURE",
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(events),
    /secret-token|private-thread|hostile-target-id-secret|raw init/,
  );
});

test("FRESH snapshot failure is distinguishable from FRESH focus failure", async () => {
  const events: M2PublicCdpReadinessDiagnosticEvent[] = [];
  const { runtime, transport, wrapped } = createWrappedManager(events);
  await wrapped.connect();
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
  assert.ok(events.every((event) => event.prepareCdpMode === "REUSED_CONNECTED"));
  assert.doesNotMatch(JSON.stringify(events), /secret-token|private-thread/);
});

class ClassifiedFailureManager extends CdpSessionManager {
  public constructor(private readonly failure: Error) {
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

async function observeFreshFailure(failure: Error): Promise<{
  readonly observed: unknown;
  readonly events: readonly M2PublicCdpReadinessDiagnosticEvent[];
}> {
  const events: M2PublicCdpReadinessDiagnosticEvent[] = [];
  const diagnostic = new M2PublicCdpReadinessDiagnostic((event) => events.push(event));
  diagnostic.observePrepareMode("REUSED_CONNECTED");
  const wrapped = wrapM2PublicCdpReadinessDiagnostics(
    new ClassifiedFailureManager(failure),
    diagnostic,
  );
  const controller = fastFreshController(wrapped);

  let observed: unknown;
  try {
    await controller.waitForFreshRoute(createRuntime().getCurrentRuntimeLease());
  } catch (error) {
    observed = error;
  }
  return { observed, events };
}

test("provenance and disconnect wrappers emit only exact public-readiness-capable classes", async () => {
  const provenance = await observeFreshFailure(
    new RuntimeProvenanceUnverifiedError("hostile provenance secret-token"),
  );
  assert.ok(provenance.observed instanceof CdpReadinessFailedError);
  assert.equal(serializePublicError(provenance.observed).error.code, "CDP_READINESS_FAILED");
  assert.deepEqual(provenance.events, [
    {
      schema: "M2_PUBLIC_CDP_DIAGNOSTIC_V1",
      operation: "PUBLIC_CDP_READINESS_RCA",
      prepareCdpMode: "REUSED_CONNECTED",
      stage: "BOUND_RUNTIME_CURRENTNESS",
      errorClass: "PROVENANCE_UNVERIFIED",
      outcome: "FAILURE",
    },
  ]);

  const disconnected = await observeFreshFailure(
    new CdpDisconnectedError("hostile disconnected private-thread"),
  );
  assert.ok(disconnected.observed instanceof CdpReadinessFailedError);
  assert.deepEqual(
    disconnected.events.map(({ stage, errorClass }) => ({ stage, errorClass })),
    [{ stage: "FRESH_READINESS_SNAPSHOT", errorClass: "SESSION_UNAVAILABLE" }],
  );
  assert.doesNotMatch(
    JSON.stringify([...provenance.events, ...disconnected.events]),
    /secret-token|private-thread|hostile/,
  );
});

test("abort and runtime replacement retain distinct errors and emit no readiness fact", async () => {
  const abort = new OperationAbortedError("hostile abort target-id");
  const aborted = await observeFreshFailure(abort);
  assert.strictEqual(aborted.observed, abort);
  assert.equal(serializePublicError(abort).error.code, "OPERATION_ABORTED");
  assert.deepEqual(aborted.events, []);

  const replacement = new RuntimeGenerationChangedError("hostile replacement private-thread");
  const replaced = await observeFreshFailure(replacement);
  assert.strictEqual(replaced.observed, replacement);
  assert.equal(serializePublicError(replacement).error.code, "RUNTIME_GENERATION_CHANGED");
  assert.deepEqual(replaced.events, []);
});

test("BOUND_EXISTING focus provenance stays fail-closed while diagnostic remains observational", async () => {
  const runtime = createRuntime();
  const transport = new FakeTransport();
  const guard = new FakeProvenanceGuard();
  const raw = new BoundCdpSessionManager(config, runtime, guard, {
    discovery: new StaticDiscovery(),
    transport,
    attachTimeoutMs: 50,
    provenanceTimeoutMs: 50,
  });
  const events: M2PublicCdpReadinessDiagnosticEvent[] = [];
  const wrapped = wrapM2PublicCdpReadinessDiagnostics(
    raw,
    new M2PublicCdpReadinessDiagnostic((event) => events.push(event)),
  );
  const lease = runtime.getCurrentRuntimeLease();

  await wrapped.bindExistingRuntime(lease);
  await wrapped.connect();
  transport.sessions[0]!.readinessSnapshot = unfocusedSnapshot;
  guard.failure = new RuntimeProvenanceUnverifiedError(
    "hostile provenance token=secret-token private-thread",
  );

  let observed: unknown;
  try {
    await fastFreshController(wrapped).waitForFreshRoute(lease);
  } catch (error) {
    observed = error;
  }

  assert.ok(observed instanceof CdpReadinessFailedError);
  assert.equal(serializePublicError(observed).error.code, "CDP_READINESS_FAILED");
  assert.equal(transport.sessions[0]!.focusCalls, 0, "provenance must fail before DOM focus");
  assert.ok(guard.bindCalls >= 1);
  assert.ok(guard.assertCalls >= 1);
  assert.deepEqual(events, [
    {
      schema: "M2_PUBLIC_CDP_DIAGNOSTIC_V1",
      operation: "PUBLIC_CDP_READINESS_RCA",
      prepareCdpMode: "REUSED_CONNECTED",
      stage: "BOUND_RUNTIME_CURRENTNESS",
      errorClass: "PROVENANCE_UNVERIFIED",
      outcome: "FAILURE",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /secret-token|private-thread|hostile/);
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

test("ordinary FRESH timeout and navigation public classes remain unchanged", async () => {
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

test("diagnostic sink failure cannot replace the product failure", async () => {
  const runtime = createRuntime();
  const transport = new FakeTransport();
  const raw = new CdpSessionManager(config, runtime, {
    discovery: new StaticDiscovery(),
    transport,
    attachTimeoutMs: 50,
  });
  const wrapped = wrapM2PublicCdpReadinessDiagnostics(
    raw,
    new M2PublicCdpReadinessDiagnostic(() => {
      throw new Error("diagnostic sink failed");
    }),
  );

  await wrapped.connect();
  await wrapped.connect();
  const lease = runtime.getCurrentRuntimeLease();
  transport.sessions[0]!.readinessFailure = new Error("raw product failure");

  await assert.rejects(
    () => wrapped.getReadinessSnapshot({ kind: "FRESH_ROOT" }, lease),
    CdpReadinessFailedError,
  );
});
