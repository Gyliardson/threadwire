import assert from "node:assert/strict";
import test from "node:test";
import {
  CdpControllerPort,
  RuntimeControllerPort,
  ThreadwireController,
  ThreadwireControllerDependencies,
} from "../../src/controller/ThreadwireController.js";
import { RuntimeGeneration, RuntimeLease } from "../../src/domain/RuntimeGeneration.js";
import { CdpConnectionState } from "../../src/domain/RuntimeState.js";
import { ThreadHandle } from "../../src/domain/ThreadIdentity.js";
import {
  RuntimeProvenanceUnverifiedError,
  RuntimeRecoveryForbiddenError,
} from "../../src/domain/errors.js";

function lease(): RuntimeLease {
  return Object.freeze({
    generation: 1 as RuntimeGeneration,
    identity: Object.freeze({ pid: 100, creationTime: "2026-09-02T12:00:00.0000000Z" }),
  });
}

class FakeRuntime implements RuntimeControllerPort {
  public ensureCalls = 0;
  public requireCalls = 0;
  public restartCalls = 0;
  public inspectCalls = 0;
  public readonly admitted = lease();
  public async inspect() {
    this.inspectCalls += 1;
    return { isRunning: true };
  }
  public async ensureStarted(): Promise<void> {
    this.ensureCalls += 1;
  }
  public async requireExisting(): Promise<RuntimeLease> {
    this.requireCalls += 1;
    return this.admitted;
  }
  public async restart(): Promise<void> {
    this.restartCalls += 1;
  }
}

class FakeCdp implements CdpControllerPort {
  public state: CdpConnectionState = "CONNECTED";
  public connectCalls = 0;
  public disconnectCalls = 0;
  public assertCalls = 0;
  public bindCalls = 0;
  public boundAssertCalls = 0;
  public failBoundAssert = false;
  public async connect(): Promise<void> {
    this.connectCalls += 1;
  }
  public async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }
  public assertCurrentRuntime(): void {
    this.assertCalls += 1;
  }
  public async bindExistingRuntime(): Promise<void> {
    this.bindCalls += 1;
  }
  public async assertBoundRuntimeCurrent(): Promise<void> {
    this.boundAssertCalls += 1;
    if (this.failBoundAssert) {
      throw new RuntimeProvenanceUnverifiedError();
    }
  }
}

function dependencies(runtime: FakeRuntime, cdp: FakeCdp) {
  let routeCalls = 0;
  let executeCalls = 0;
  let projectCalls = 0;
  const deps: ThreadwireControllerDependencies = {
    runtime,
    cdp,
    registry: {
      resolve: () => undefined,
      registrationState: () => "COMMITTED",
      waitForCommit: async () => undefined,
      knownThreads: () => [],
    },
    projectRegistry: {
      resolve: () => "https://chatgpt.com/g/g-p-synthetic/project" as never,
    },
    router: {
      routeFresh: async () => {
        routeCalls += 1;
      },
      routeToThread: async () => {
        routeCalls += 1;
      },
      routeToProject: async () => {
        routeCalls += 1;
      },
    },
    executor: {
      executeStreaming: async () => {
        executeCalls += 1;
        return {
          kind: "THREAD",
          threadHandle: "tw_synthetic" as ThreadHandle,
          created: true as const,
        };
      },
    },
    projectCreator: {
      create: async () => {
        projectCalls += 1;
        return { projectHandle: "prj_synthetic" as never };
      },
    },
  };
  return {
    deps,
    routeCalls: () => routeCalls,
    executeCalls: () => executeCalls,
    projectCalls: () => projectCalls,
  };
}

test("BOUND_EXISTING admission and turns never call managed auto-start", async () => {
  const runtime = new FakeRuntime();
  const cdp = new FakeCdp();
  const f = dependencies(runtime, cdp);
  const controller = new ThreadwireController(f.deps, { classicPolicy: "BOUND_EXISTING" });
  await controller.initialize();
  await controller.executeTurn(
    { target: { kind: "FRESH" }, prompt: "synthetic" },
    () => undefined,
  );
  assert.equal(runtime.requireCalls, 1);
  assert.equal(runtime.ensureCalls, 0);
  assert.equal(cdp.bindCalls, 1);
  assert.equal(f.routeCalls(), 1);
  assert.equal(f.executeCalls(), 1);
});

test("BOUND_EXISTING final provenance guard prevents turn dispatch", async () => {
  const runtime = new FakeRuntime();
  const cdp = new FakeCdp();
  const f = dependencies(runtime, cdp);
  f.deps.router.routeFresh = async () => {
    cdp.failBoundAssert = true;
  };
  const controller = new ThreadwireController(f.deps, { classicPolicy: "BOUND_EXISTING" });
  await controller.initialize();
  await assert.rejects(
    controller.executeTurn(
      { target: { kind: "FRESH" }, prompt: "synthetic" },
      () => undefined,
    ),
    RuntimeProvenanceUnverifiedError,
  );
  assert.equal(f.executeCalls(), 0);
  assert.equal(runtime.ensureCalls, 0);
});

test("BOUND_EXISTING project creation is provenance guarded", async () => {
  const runtime = new FakeRuntime();
  const cdp = new FakeCdp();
  const f = dependencies(runtime, cdp);
  const controller = new ThreadwireController(f.deps, { classicPolicy: "BOUND_EXISTING" });
  await controller.initialize();
  await controller.createProject({ name: "Synthetic" });
  assert.equal(f.projectCalls(), 1);
  assert.ok(cdp.boundAssertCalls >= 3);
  assert.equal(runtime.ensureCalls, 0);
});

test("BOUND_EXISTING recovery is rejected before every lifecycle side effect", async () => {
  const runtime = new FakeRuntime();
  const cdp = new FakeCdp();
  const f = dependencies(runtime, cdp);
  const controller = new ThreadwireController(f.deps, { classicPolicy: "BOUND_EXISTING" });
  await assert.rejects(controller.recoverRuntime(), RuntimeRecoveryForbiddenError);
  assert.equal(cdp.disconnectCalls, 0);
  assert.equal(runtime.restartCalls, 0);
  assert.equal(cdp.connectCalls, 0);
  assert.equal(runtime.ensureCalls, 0);
});

test("BOUND_EXISTING health fails instead of claiming healthy when provenance is invalid", async () => {
  const runtime = new FakeRuntime();
  const cdp = new FakeCdp();
  const f = dependencies(runtime, cdp);
  const controller = new ThreadwireController(f.deps, { classicPolicy: "BOUND_EXISTING" });
  await controller.initialize();
  cdp.failBoundAssert = true;
  await assert.rejects(controller.health(), RuntimeProvenanceUnverifiedError);
});

test("MANAGED preserves ensureStarted/connect/assert behavior", async () => {
  const runtime = new FakeRuntime();
  const cdp = new FakeCdp();
  const f = dependencies(runtime, cdp);
  const controller = new ThreadwireController(f.deps, { classicPolicy: "MANAGED" });
  await controller.executeTurn(
    { target: { kind: "FRESH" }, prompt: "synthetic" },
    () => undefined,
  );
  assert.equal(runtime.ensureCalls, 1);
  assert.equal(runtime.requireCalls, 0);
  assert.equal(cdp.connectCalls, 1);
  assert.equal(cdp.assertCalls, 1);
  assert.equal(cdp.bindCalls, 0);
  assert.equal(cdp.boundAssertCalls, 0);
});
