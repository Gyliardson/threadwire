import assert from "node:assert/strict";
import test from "node:test";
import {
  CdpTurnComposerState,
  CdpTurnObservationHandle,
  CdpTurnObservationSnapshot,
} from "../../src/cdp/CdpTransport.js";
import {
  RuntimeGenerationTracker,
  RuntimeLease,
} from "../../src/domain/RuntimeGeneration.js";
import {
  CdpDisconnectedError,
  FreshConversationNotCreatedError,
  OperationAbortedError,
  RuntimeGenerationChangedError,
  TurnInputFailedError,
  TurnStateUncertainError,
  TurnWriteFailedError,
} from "../../src/domain/errors.js";
import {
  ConversationLocator,
  createConversationLocator,
} from "../../src/domain/ThreadIdentity.js";
import { createProjectLocator } from "../../src/domain/ProjectIdentity.js";
import { RouteExpectation } from "../../src/readiness/types.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";
import { ThreadRegistry } from "../../src/routing/ThreadRegistry.js";
import { TurnExecutor } from "../../src/turn/TurnExecutor.js";
import {
  TurnCdpPort,
  TurnComposerPreflightPort,
} from "../../src/turn/types.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function createRuntime(): RuntimeGenerationTracker {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 100, creationTime: "runtime-a" });
  return runtime;
}

const observationHandle = Object.freeze({}) as unknown as CdpTurnObservationHandle;

function observation(
  lifecycle: "ACTIVE" | "FINISHED" | "FAILED" | null,
  prepareCount = 0,
): CdpTurnObservationSnapshot {
  return Object.freeze({
    prepareCount,
    write:
      lifecycle === null
        ? null
        : Object.freeze({ lifecycle }),
  });
}

class FakePreflight implements TurnComposerPreflightPort {
  public readonly events: string[] = [];
  public calls = 0;
  public lastExpectation: RouteExpectation | null = null;
  public onCall: (() => void) | null = null;

  public async waitForTurnComposer(
    expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<void> {
    this.calls += 1;
    this.events.push("preflight");
    this.lastExpectation = expectedRoute;
    this.onCall?.();
  }
}

class FakeCdp implements TurnCdpPort {
  public readonly events: string[] = [];
  public composer: CdpTurnComposerState = Object.freeze({
    expectedRoute: true,
    eligible: true,
    focused: true,
    empty: true,
    backendDOMNodeId: 501,
  });
  public locator: ConversationLocator | null = null;
  public locators: ConversationLocator[] = [];
  public snapshots: readonly CdpTurnObservationSnapshot[] = [observation("FINISHED")];
  public snapshotCalls = 0;
  public insertCalls = 0;
  public projectInsertCalls = 0;
  public onArm: (() => void) | null = null;
  public onInsert: (() => void) | null = null;
  public onKeyDown: (() => void) | null = null;
  public onSendButton: (() => void) | null = null;
  public projectInsertError: Error | null = null;
  public sendButtonError: Error | null = null;
  public writeOnProjectInsert = false;
  public observationError: Error | null = null;
  private submitted = false;

  public constructor(private readonly runtime: RuntimeGenerationTracker) {}

  public async getTurnComposerState(
    _expectedRoute: RouteExpectation,
    lease: RuntimeLease,
  ): Promise<CdpTurnComposerState> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.events.push("composer-state");
    return this.composer;
  }

  public armTurnObservation(lease: RuntimeLease): CdpTurnObservationHandle {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.events.push("arm-observer");
    this.onArm?.();
    return observationHandle;
  }

  public getTurnObservation(
    _handle: CdpTurnObservationHandle,
    lease: RuntimeLease,
  ): CdpTurnObservationSnapshot {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.events.push("observe");
    if (!this.submitted) {
      return observation(null);
    }
    if (this.observationError) {
      throw this.observationError;
    }
    const value =
      this.snapshots[this.snapshotCalls] ?? this.snapshots[this.snapshots.length - 1] ?? observation(null);
    this.snapshotCalls += 1;
    return value;
  }

  public releaseTurnObservation(_handle: CdpTurnObservationHandle): void {
    this.events.push("release-observer");
  }

  public async insertText(_text: string, lease: RuntimeLease): Promise<void> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.insertCalls += 1;
    this.events.push("insert-text");
    this.onInsert?.();
  }

  public async insertTextIntoProjectComposer(
    _text: string,
    projectLocator: import("../../src/domain/ProjectIdentity.js").ProjectLocator,
    backendDOMNodeId: number,
    lease: RuntimeLease,
  ): Promise<number> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.projectInsertCalls += 1;
    this.events.push("insert-project-text");
    this.clickedProjectLocator = projectLocator;
    this.clickedBackendDOMNodeId = backendDOMNodeId;
    this.onInsert?.();
    if (this.writeOnProjectInsert) this.submitted = true;
    if (this.projectInsertError !== null) throw this.projectInsertError;
    return 601;
  }

  public async clickExistingTurnSendButton(

    _conversationLocator: unknown,

    _backendDOMNodeId: number,

    _expectedText: string,

    lease: RuntimeLease,

  ): Promise<void> {

    await this.dispatchEnterKeyDown(lease);

    await this.dispatchEnterKeyUp(lease);

  }


  public async dispatchEnterKeyDown(lease: RuntimeLease): Promise<void> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.events.push("enter-down");
    this.submitted = true;
    this.onKeyDown?.();
    this.runtime.assertRuntimeLeaseCurrent(lease);
  }

  public async dispatchEnterKeyUp(lease: RuntimeLease): Promise<void> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.events.push("enter-up");
  }

  public clickedProjectLocator: string | null = null;
  public clickedBackendDOMNodeId: number | null = null;
  public clickedExpectedText: string | null = null;

  public async clickTurnSendButton(
    projectLocator: import("../../src/domain/ProjectIdentity.js").ProjectLocator,
    backendDOMNodeId: number,
    _formBackendDOMNodeId: number,
    expectedText: string,
    lease: RuntimeLease,
  ): Promise<void> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.events.push("send-button");
    this.clickedProjectLocator = projectLocator;
    this.clickedBackendDOMNodeId = backendDOMNodeId;
    this.clickedExpectedText = expectedText;
    if (this.sendButtonError !== null) throw this.sendButtonError;
    this.submitted = true;
    this.onSendButton?.();
    this.runtime.assertRuntimeLeaseCurrent(lease);
  }

  public async getCurrentConversationLocator(
    lease: RuntimeLease,
  ): Promise<ConversationLocator | null> {
    this.runtime.assertRuntimeLeaseCurrent(lease);
    this.events.push("route-observation");
    return this.locators.shift() ?? this.locator;
  }
}

function fixture(options: {
  snapshots?: readonly CdpTurnObservationSnapshot[];
  locator?: ConversationLocator | null;
  sleep?: (ms: number) => Promise<void>;
  now?: { value: number };
} = {}) {
  const runtime = createRuntime();
  const scheduler = new OperationScheduler(runtime);
  const registry = new ThreadRegistry({ handleFactory: (() => {
    let index = 0;
    return () => `handle_${++index}`;
  })() });
  const existingLocator = createConversationLocator("https://chatgpt.com/c/synthetic-existing");
  const existingHandle = registry.register(existingLocator);
  const preflight = new FakePreflight();
  const cdp = new FakeCdp(runtime);
  cdp.snapshots = options.snapshots ?? [observation("FINISHED")];
  cdp.locator = options.locator ?? null;
  const now = options.now ?? { value: 0 };
  const sleep = options.sleep ?? (async (ms: number) => {
    now.value += Math.max(ms, 1);
  });
  const executor = new TurnExecutor(registry, scheduler, preflight, cdp, {
    commandTimeoutMs: 100,
    writeObservationTimeoutMs: 3,
    writeSettlementTimeoutMs: 3,
    freshConversationTimeoutMs: 3,
    pollIntervalMs: 1,
    clock: () => now.value,
    sleep,
  });
  return {
    runtime,
    scheduler,
    registry,
    existingLocator,
    existingHandle,
    preflight,
    cdp,
    executor,
    now,
  };
}

test("existing turn preflights, arms observation before input, and returns the existing opaque handle", async () => {
  const f = fixture({ snapshots: [observation("ACTIVE", 7), observation("FINISHED", 7)] });
  const result = await f.executor.execute(
    { kind: "THREAD", threadHandle: f.existingHandle },
    "synthetic prompt",
  );

  assert.deepEqual(result, {
    kind: "THREAD",
    threadHandle: f.existingHandle,
    created: false,
  });
  assert.equal(f.preflight.lastExpectation?.kind, "THREAD");
  assert.deepEqual(f.cdp.events.slice(0, 6), [
    "composer-state",
    "arm-observer",
    "insert-text",
    "observe",
    "enter-down",
    "enter-up",
  ]);
  assert.equal(f.preflight.events[0], "preflight");
  assert.ok(f.cdp.events.indexOf("arm-observer") < f.cdp.events.indexOf("insert-text"));
  assert.ok(f.cdp.events.indexOf("insert-text") < f.cdp.events.indexOf("enter-down"));
  assert.ok(f.cdp.events.indexOf("enter-down") < f.cdp.events.indexOf("enter-up"));
});

test("final composer validation rejects expected-route drift before observation or input", async () => {
  const f = fixture();
  f.cdp.composer = Object.freeze({
    expectedRoute: false,
    eligible: true,
    focused: true,
    empty: true,
  });

  await assert.rejects(
    () => f.executor.execute({ kind: "THREAD", threadHandle: f.existingHandle }, "synthetic prompt"),
    TurnInputFailedError,
  );
  assert.equal(f.cdp.insertCalls, 0);
  assert.equal(f.cdp.events.includes("arm-observer"), false);
});

test("prepare observation is independent and zero prepares do not replace the mandatory write signal", async () => {
  const f = fixture({ snapshots: [observation("FINISHED", 0)] });
  const result = await f.executor.execute(
    { kind: "THREAD", threadHandle: f.existingHandle },
    "synthetic prompt",
  );
  assert.equal(result.created, false);
  assert.equal(f.cdp.snapshotCalls, 1);
});

test("command acceptance alone never reports success and missing write fails closed", async () => {
  const f = fixture({ snapshots: [observation(null)] });
  await assert.rejects(
    () => f.executor.execute({ kind: "THREAD", threadHandle: f.existingHandle }, "synthetic prompt"),
    TurnStateUncertainError,
  );
  assert.equal(f.cdp.insertCalls, 1);

  let routeRan = false;
  await assert.rejects(
    () => f.scheduler.schedule("ROUTE", async () => {
      routeRan = true;
    }),
    TurnStateUncertainError,
  );
  assert.equal(routeRan, false);
});

test("loadingFailed is a settled failed turn and does not poison later routing", async () => {
  const f = fixture({ snapshots: [observation("FAILED", 2)] });
  await assert.rejects(
    () => f.executor.execute({ kind: "THREAD", threadHandle: f.existingHandle }, "synthetic prompt"),
    TurnWriteFailedError,
  );
  let routeRan = false;
  await f.scheduler.schedule("ROUTE", async () => {
    routeRan = true;
  });
  assert.equal(routeRan, true);
});

test("fresh turn requires write plus resulting supported route before registering an opaque handle", async () => {
  const freshLocator = createConversationLocator("https://chatgpt.com/c/synthetic-fresh-secret");
  const f = fixture({
    snapshots: [observation("ACTIVE", 1), observation("FINISHED", 1)],
    locator: freshLocator,
  });
  const result = await f.executor.execute({ kind: "FRESH" }, "synthetic prompt");

  assert.equal(result.kind, "THREAD");
  assert.equal(result.created, true);
  assert.match(result.threadHandle, /^tw_/);
  assert.equal(f.registry.resolve(result.threadHandle), freshLocator);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("synthetic-fresh-secret"), false);
  assert.equal(serialized.includes("https://chatgpt.com"), false);
});

test("fresh write without a resulting supported route never reports creation success", async () => {
  const f = fixture({ snapshots: [observation("FINISHED", 3)], locator: null });
  await assert.rejects(
    () => f.executor.execute({ kind: "FRESH" }, "synthetic prompt"),
    FreshConversationNotCreatedError,
  );

  let routeRan = false;
  await f.scheduler.schedule("ROUTE", async () => {
    routeRan = true;
  });
  assert.equal(routeRan, true, "write was settled, so the route queue is safe to release");
});

test("project turn uses the send button and registers only a conversation owned by that Project", async () => {
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000040/project");
  const conversationLocator = createConversationLocator(
    "https://chatgpt.com/g/g-p-00000000000000000000000000000040/c/project-conversation",
  );
  const f = fixture({
    snapshots: [observation("ACTIVE", 1), observation("FINISHED", 1)],
    locator: conversationLocator,
  });

  const result = await f.executor.execute(
    { kind: "PROJECT", projectLocator },
    "synthetic project prompt",
  );

  assert.equal(result.created, true);
  assert.equal(f.registry.resolve(result.threadHandle), conversationLocator);
  assert.equal(f.preflight.lastExpectation?.kind, "PROJECT_ROOT");
  assert.equal(f.cdp.events.includes("send-button"), true);
  assert.equal(f.cdp.projectInsertCalls, 1);
  assert.equal(f.cdp.insertCalls, 0);
  assert.equal(f.cdp.clickedProjectLocator, projectLocator);
  assert.equal(f.cdp.clickedBackendDOMNodeId, 501);
  assert.equal(f.cdp.clickedExpectedText, "synthetic project prompt");
  assert.equal(f.cdp.events.includes("enter-down"), false);
  assert.equal(JSON.stringify(result).includes("g-p-00000000000000000000000000000040"), false);
});

test("project turn fails closed when the resulting conversation was already registered", async () => {
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000041/project");
  const conversationLocator = createConversationLocator(
    "https://chatgpt.com/g/g-p-00000000000000000000000000000041/c/project-conversation",
  );
  const f = fixture({ snapshots: [observation("FINISHED", 1)], locator: conversationLocator });
  f.registry.register(conversationLocator);

  await assert.rejects(
    () => f.executor.execute({ kind: "PROJECT", projectLocator }, "synthetic prompt"),
    TurnStateUncertainError,
  );
  assert.equal(f.registry.knownThreads().length, 2);
  await assert.rejects(
    f.scheduler.schedule("ROUTE", async () => "must-not-run"),
    TurnStateUncertainError,
  );
});

test("Project send-control refusal fails closed without accepting a later write", async () => {
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000042/project");
  const f = fixture();
  f.cdp.sendButtonError = new Error("send control unavailable");

  await assert.rejects(
    () => f.executor.execute({ kind: "PROJECT", projectLocator }, "synthetic prompt"),
    TurnStateUncertainError,
  );
  assert.equal(f.cdp.events.filter((event) => event === "send-button").length, 1);
  assert.equal(f.cdp.events.filter((event) => event === "observe").length, 1);
  await assert.rejects(
    f.scheduler.schedule("ROUTE", async () => "must-not-run"),
    TurnStateUncertainError,
  );
});

test("terminal Project write before the intended send boundary fails closed", async () => {
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000043/project");
  const f = fixture({ snapshots: [observation("FINISHED")] });
  f.cdp.writeOnProjectInsert = true;

  await assert.rejects(
    () => f.executor.execute({ kind: "PROJECT", projectLocator }, "synthetic prompt"),
    TurnStateUncertainError,
  );
  assert.equal(f.cdp.events.includes("send-button"), false);
  await assert.rejects(
    f.scheduler.schedule("ROUTE", async () => "must-not-run"),
    TurnStateUncertainError,
  );
});

test("failed Project write after send latches uncertainty", async () => {
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000044/project");
  const f = fixture({ snapshots: [observation("FAILED")] });

  await assert.rejects(
    () => f.executor.execute({ kind: "PROJECT", projectLocator }, "synthetic prompt"),
    TurnStateUncertainError,
  );
  await assert.rejects(
    f.scheduler.schedule("ROUTE", async () => "must-not-run"),
    TurnStateUncertainError,
  );
});

test("fresh turn rejects a Project-qualified resulting route", async () => {
  const projectConversation = createConversationLocator(
    "https://chatgpt.com/g/g-p-00000000000000000000000000000045/c/project-conversation",
  );
  const f = fixture({ snapshots: [observation("FINISHED", 1)], locator: projectConversation });

  await assert.rejects(
    () => f.executor.execute({ kind: "FRESH" }, "synthetic prompt"),
    FreshConversationNotCreatedError,
  );
  assert.equal(f.registry.knownThreads().length, 1);
});

test("project turn rejects same-Project conversation drift before registration", async () => {
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000040/project");
  const first = createConversationLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000040/c/conversation-a");
  const second = createConversationLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000040/c/conversation-b");
  const f = fixture({ snapshots: [observation("FINISHED", 1)] });
  f.cdp.locators.push(first, second);

  await assert.rejects(
    () => f.executor.execute({ kind: "PROJECT", projectLocator }, "synthetic prompt"),
    TurnStateUncertainError,
  );
  assert.equal(f.registry.knownThreads().length, 1);
  await assert.rejects(
    f.scheduler.schedule("ROUTE", async () => "must-not-run"),
    TurnStateUncertainError,
  );
});

test("project turn rejects a resulting conversation owned by another Project", async () => {
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000040/project");
  const foreignLocator = createConversationLocator(
    "https://chatgpt.com/g/g-p-00000000000000000000000000000049/c/project-conversation",
  );
  const f = fixture({ snapshots: [observation("FINISHED", 1)], locator: foreignLocator });

  await assert.rejects(
    () => f.executor.execute({ kind: "PROJECT", projectLocator }, "synthetic project prompt"),
    TurnStateUncertainError,
  );
  assert.equal(f.registry.knownThreads().length, 1);
});

test("pre-aborted and post-arm pre-commit aborts never issue input", async () => {
  const preAborted = fixture();
  const firstAbort = new AbortController();
  firstAbort.abort(new Error("cancel"));
  await assert.rejects(
    () => preAborted.executor.execute(
      { kind: "THREAD", threadHandle: preAborted.existingHandle },
      "synthetic prompt",
      firstAbort.signal,
    ),
    OperationAbortedError,
  );
  assert.equal(preAborted.preflight.calls, 0);
  assert.equal(preAborted.cdp.insertCalls, 0);

  const postArm = fixture();
  const secondAbort = new AbortController();
  postArm.cdp.onArm = () => secondAbort.abort(new Error("cancel after arm"));
  await assert.rejects(
    () => postArm.executor.execute(
      { kind: "THREAD", threadHandle: postArm.existingHandle },
      "synthetic prompt",
      secondAbort.signal,
    ),
    OperationAbortedError,
  );
  assert.equal(postArm.cdp.insertCalls, 0);
});

test("post-commit abort retains TURN ownership until the exact write lifecycle settles", async () => {
  const sleepStarted = deferred<void>();
  const releaseSleep = deferred<void>();
  let sleepCalls = 0;
  const now = { value: 0 };
  const f = fixture({
    snapshots: [observation("ACTIVE"), observation("FINISHED")],
    now,
    sleep: async (ms) => {
      now.value += Math.max(ms, 1);
      sleepCalls += 1;
      if (sleepCalls === 1) {
        sleepStarted.resolve();
        await releaseSleep.promise;
      }
    },
  });
  const abort = new AbortController();
  const turn = f.executor.execute(
    { kind: "THREAD", threadHandle: f.existingHandle },
    "synthetic prompt",
    abort.signal,
  );

  await sleepStarted.promise;
  abort.abort(new Error("post-commit cancel"));
  let routeRan = false;
  const route = f.scheduler.schedule("ROUTE", async () => {
    routeRan = true;
  });
  await Promise.resolve();
  assert.equal(routeRan, false);

  releaseSleep.resolve();
  await assert.rejects(turn, OperationAbortedError);
  await route;
  assert.equal(routeRan, true);
  assert.ok(f.cdp.events.includes("enter-down"));
  assert.ok(f.cdp.events.includes("enter-up"));
});

test("post-commit observation loss fails closed and prevents queued navigation", async () => {
  const f = fixture();
  f.cdp.observationError = new CdpDisconnectedError();
  await assert.rejects(
    () => f.executor.execute({ kind: "THREAD", threadHandle: f.existingHandle }, "synthetic prompt"),
    TurnStateUncertainError,
  );

  let routeRan = false;
  await assert.rejects(
    () => f.scheduler.schedule("ROUTE", async () => {
      routeRan = true;
    }),
    TurnStateUncertainError,
  );
  assert.equal(routeRan, false);
});

test("runtime replacement during a committed old-runtime turn rejects stale work without latching the replacement", async () => {
  const f = fixture();
  f.cdp.onKeyDown = () => {
    f.runtime.observe({ pid: 200, creationTime: "runtime-b" });
  };

  await assert.rejects(
    () => f.executor.execute({ kind: "THREAD", threadHandle: f.existingHandle }, "synthetic prompt"),
    RuntimeGenerationChangedError,
  );

  let newGenerationRan = false;
  await f.scheduler.schedule("TURN", async () => {
    newGenerationRan = true;
  });
  assert.equal(newGenerationRan, true);
});

test("runtime replacement during Project submission cannot register a conversation", async () => {
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000046/project");
  const conversationLocator = createConversationLocator(
    "https://chatgpt.com/g/g-p-00000000000000000000000000000046/c/conversation",
  );
  const f = fixture({ snapshots: [observation("FINISHED")], locator: conversationLocator });
  f.cdp.onSendButton = () => {
    f.runtime.observe({ pid: 200, creationTime: "runtime-b" });
  };

  await assert.rejects(
    () => f.executor.execute({ kind: "PROJECT", projectLocator }, "synthetic prompt"),
    RuntimeGenerationChangedError,
  );
  assert.equal(f.registry.knownThreads().length, 1);
});

test("Project cancellation after exact-node insertion but before send latches uncertainty", async () => {
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000047/project");
  const f = fixture();
  const abort = new AbortController();
  f.cdp.onInsert = () => abort.abort(new Error("cancel after Project insertion"));
  f.cdp.projectInsertError = new Error("ambiguous Project insertion failure");

  await assert.rejects(
    () => f.executor.execute(
      { kind: "PROJECT", projectLocator },
      "synthetic prompt",
      abort.signal,
    ),
    TurnStateUncertainError,
  );
  assert.equal(f.cdp.projectInsertCalls, 1);
  assert.equal(f.cdp.events.includes("send-button"), false);
  await assert.rejects(
    f.scheduler.schedule("ROUTE", async () => "must-not-run"),
    TurnStateUncertainError,
  );
});

test("post-click Project cancellation latches uncertainty after safe write settlement", async () => {
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000048/project");
  const conversationLocator = createConversationLocator(
    "https://chatgpt.com/g/g-p-00000000000000000000000000000048/c/conversation",
  );
  const now = { value: 0 };
  const f = fixture({
    snapshots: [observation("ACTIVE"), observation("FINISHED")],
    locator: conversationLocator,
    now,
    sleep: async (ms) => {
      now.value += Math.max(ms, 1);
      abort.abort(new Error("cancel after Project click"));
    },
  });
  const abort = new AbortController();

  await assert.rejects(
    () => f.executor.execute(
      { kind: "PROJECT", projectLocator },
      "synthetic prompt",
      abort.signal,
    ),
    TurnStateUncertainError,
  );
  assert.equal(f.cdp.events.filter((event) => event === "send-button").length, 1);
  assert.equal(f.registry.knownThreads().length, 1);
  await assert.rejects(
    f.scheduler.schedule("ROUTE", async () => "must-not-run"),
    TurnStateUncertainError,
  );
});

test("stale queued TURN is rejected before preflight or input mutation", async () => {
  const f = fixture();
  const blocker = deferred<void>();
  const active = f.scheduler.schedule("TURN", async () => await blocker.promise);
  const queued = f.executor.execute(
    { kind: "THREAD", threadHandle: f.existingHandle },
    "synthetic prompt",
  );

  await Promise.resolve();
  f.runtime.observe({ pid: 200, creationTime: "runtime-b" });
  blocker.resolve();
  await active;
  await assert.rejects(queued, RuntimeGenerationChangedError);
  assert.equal(f.preflight.calls, 0);
  assert.equal(f.cdp.insertCalls, 0);
});

test("second TURN remains serialized behind the active TURN", async () => {
  const firstSleepStarted = deferred<void>();
  const releaseFirstSleep = deferred<void>();
  const now = { value: 0 };
  let sleepCalls = 0;
  const first = fixture({
    snapshots: [observation("ACTIVE"), observation("FINISHED")],
    now,
    sleep: async (ms) => {
      now.value += Math.max(ms, 1);
      sleepCalls += 1;
      if (sleepCalls === 1) {
        firstSleepStarted.resolve();
        await releaseFirstSleep.promise;
      }
    },
  });
  const secondPreflight = new FakePreflight();
  const secondCdp = new FakeCdp(first.runtime);
  secondCdp.snapshots = [observation("FINISHED")];
  const secondExecutor = new TurnExecutor(
    first.registry,
    first.scheduler,
    secondPreflight,
    secondCdp,
    {
      commandTimeoutMs: 100,
      writeObservationTimeoutMs: 3,
      writeSettlementTimeoutMs: 3,
      freshConversationTimeoutMs: 3,
      pollIntervalMs: 1,
      clock: () => now.value,
      sleep: async (ms) => {
        now.value += Math.max(ms, 1);
      },
    },
  );

  const firstTurn = first.executor.execute(
    { kind: "THREAD", threadHandle: first.existingHandle },
    "first",
  );
  await firstSleepStarted.promise;
  const secondTurn = secondExecutor.execute(
    { kind: "THREAD", threadHandle: first.existingHandle },
    "second",
  );
  await Promise.resolve();
  assert.equal(secondPreflight.calls, 0);

  releaseFirstSleep.resolve();
  await firstTurn;
  await secondTurn;
  assert.equal(secondPreflight.calls, 1);
});

test("stable outward failures do not expose prompt, locator, request, or accessibility canaries", async () => {
  const promptCanary = "PROMPT_TEXT_SECRET";
  const f = fixture({ snapshots: [observation(null)] });
  let captured: unknown;
  try {
    await f.executor.execute(
      { kind: "THREAD", threadHandle: f.existingHandle },
      promptCanary,
    );
  } catch (error) {
    captured = error;
  }

  assert.ok(captured instanceof TurnStateUncertainError);
  const outward = `${captured.name}:${captured.message}:${captured.code}`;
  for (const canary of [
    promptCanary,
    "synthetic-existing",
    "REQUEST_ID_SECRET",
    "ACCESSIBLE_TEXT_SECRET",
  ]) {
    assert.equal(outward.includes(canary), false);
  }
});
