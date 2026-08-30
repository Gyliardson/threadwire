import assert from "node:assert/strict";
import test from "node:test";
import {
  CdpTurnComposerState,
  CdpTurnObservationHandle,
  CdpTurnObservationOptions,
  CdpTurnObservationSnapshot,
} from "../../src/cdp/CdpTransport.js";
import { RuntimeGenerationTracker, RuntimeLease } from "../../src/domain/RuntimeGeneration.js";
import { createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import { createProjectLocator } from "../../src/domain/ProjectIdentity.js";
import {
  OperationAbortedError,
  ResponseParseFailedError,
  ResponseStreamFailedError,
  RuntimeGenerationChangedError,
  ResponseStreamUnavailableError,
  ThreadNotFoundError,
  TurnStateUncertainError,
  TurnWriteFailedError,
} from "../../src/domain/errors.js";
import { RouteExpectation } from "../../src/readiness/types.js";
import {
  NormalizedResponseStreamEvent,
  ResponseStreamEvent,
} from "../../src/response/types.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";
import { ThreadRegistry } from "../../src/routing/ThreadRegistry.js";
import { TurnExecutor } from "../../src/turn/TurnExecutor.js";
import { TurnCdpPort, TurnComposerPreflightPort } from "../../src/turn/types.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class BlockingSleep {
  public readonly entered = deferred<void>();
  public readonly release = deferred<void>();
  public readonly sleep = async (_ms: number): Promise<void> => {
    this.entered.resolve();
    await this.release.promise;
  };
}

class NoopPreflight implements TurnComposerPreflightPort {
  public async waitForTurnComposer(
    _expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<void> {}
}

class FakeStreamingTurnPort implements TurnCdpPort {
  public readonly observationHandle = Object.freeze({}) as unknown as CdpTurnObservationHandle;
  public snapshot: CdpTurnObservationSnapshot = Object.freeze({
    prepareCount: 0,
    write: null,
    response: Object.freeze({ lifecycle: "PENDING" as const, failure: null }),
  });
  public readonly responseEvents: NormalizedResponseStreamEvent[] = [];
  public keyDownAction: (() => void) | null = null;
  public sendButtonAction: (() => void) | null = null;
  public locator: ReturnType<typeof createConversationLocator> | null = null;
  public readonly locators: ReturnType<typeof createConversationLocator>[] = [];
  public armOptions: CdpTurnObservationOptions | undefined;
  public discarded = false;
  public released = false;
  public runtime: RuntimeGenerationTracker | null = null;
  public baselineCalls = 0;
  public finalSnapshotCalls = 0;

  public async getTurnComposerState(
    _expectedRoute: RouteExpectation,
    _lease: RuntimeLease,
  ): Promise<CdpTurnComposerState> {
    return {
      expectedRoute: true,
      eligible: true,
      focused: true,
      empty: true,
      backendDOMNodeId: 601,
    };
  }
  public armTurnObservation(
    _lease: RuntimeLease,
    options?: CdpTurnObservationOptions,
  ): CdpTurnObservationHandle {
    this.armOptions = options;
    return this.observationHandle;
  }
  public getTurnObservation(
    _handle: CdpTurnObservationHandle,
    _lease: RuntimeLease,
  ): CdpTurnObservationSnapshot {
    this.runtime?.assertRuntimeLeaseCurrent(_lease);
    return this.snapshot;
  }
  public takeTurnResponseEvents(
    _handle: CdpTurnObservationHandle,
    _lease: RuntimeLease,
  ): readonly NormalizedResponseStreamEvent[] {
    return this.responseEvents.splice(0, this.responseEvents.length);
  }
  public discardTurnResponse(_handle: CdpTurnObservationHandle, _lease: RuntimeLease): void {
    this.discarded = true;
    this.responseEvents.splice(0, this.responseEvents.length);
  }
  public releaseTurnObservation(_handle: CdpTurnObservationHandle): void {
    this.released = true;
  }
  public async insertText(_text: string, _lease: RuntimeLease): Promise<void> {}
  public async insertTextIntoProjectComposer(
    _text: string,
    _projectLocator: ReturnType<typeof createProjectLocator>,
    _backendDOMNodeId: number,
    _lease: RuntimeLease,
  ): Promise<number> {
    return 601;
  }
  public async clickExistingTurnSendButton(
    _conversationLocator: unknown,
    _backendDOMNodeId: number,
    _expectedText: string,
    _lease: RuntimeLease,
  ): Promise<void> {
    await this.dispatchEnterKeyDown(_lease);
    await this.dispatchEnterKeyUp(_lease);
  }

  public async dispatchEnterKeyDown(_lease: RuntimeLease): Promise<void> {
    this.keyDownAction?.();
  }
  public async dispatchEnterKeyUp(_lease: RuntimeLease): Promise<void> {}
  public async clickTurnSendButton(
    _projectLocator: ReturnType<typeof createProjectLocator>,
    _backendDOMNodeId: number,
    _formBackendDOMNodeId: number,
    _expectedText: string,
    _lease: RuntimeLease,
  ): Promise<void> {
    this.sendButtonAction?.();
  }
  public async getCurrentConversationLocator(_lease: RuntimeLease) {
    return this.locators.shift() ?? this.locator;
  }
}

function settledState<T>(promise: Promise<T>): () => boolean {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

async function fixture(
  port = new FakeStreamingTurnPort(),
  sleep = new BlockingSleep(),
  options: { maxAccumulatedTextChars?: number; responseCompletionTimeoutMs?: number } = {},
) {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 600, creationTime: "m6-turn" });
  const scheduler = new OperationScheduler(runtime);
  port.runtime = runtime;
  let handleIndex = 0;
  const registry = new ThreadRegistry({
    handleFactory: () => (handleIndex++ === 0 ? "m6_handle" : "m6_project_handle"),
  });
  const locator = createConversationLocator("https://chatgpt.com/c/m6-turn");
  const handle = registry.register(locator);
  const executor = new TurnExecutor(registry, scheduler, new NoopPreflight(), port, {
    commandTimeoutMs: 100,
    writeObservationTimeoutMs: 100,
    writeSettlementTimeoutMs: 100,
    responseCompletionTimeoutMs: options.responseCompletionTimeoutMs ?? 100,
    ...(options.maxAccumulatedTextChars !== undefined
      ? { maxAccumulatedTextChars: options.maxAccumulatedTextChars }
      : {}),
    freshConversationTimeoutMs: 100,
    pollIntervalMs: 1,
    sleep: sleep.sleep,
  });
  return { runtime, scheduler, registry, handle, port, sleep, executor };
}

test("executeStreaming keeps [DONE] internal and publishes FINAL_TEXT then COMPLETED after safe settlement", async () => {
  const f = await fixture();
  const delivered: ResponseStreamEvent[] = [];
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "ACTIVE" as const }),
      response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
    });
    f.port.responseEvents.push(
      Object.freeze({ type: "TEXT_DELTA" as const, text: "hello" }),
      Object.freeze({ type: "COMPLETED" as const }),
    );
  };

  const turn = f.executor.executeStreaming(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
    (event) => delivered.push(event),
  );
  const isSettled = settledState(turn);
  await f.sleep.entered.promise;
  assert.deepEqual(f.port.armOptions, { responseStream: true });
  assert.equal(f.port.baselineCalls, 0);
  assert.deepEqual(delivered, [{ type: "TEXT_DELTA", text: "hello" }]);
  assert.equal(isSettled(), false, "semantic [DONE] must not redefine M5 transport settlement");
  assert.equal(f.port.finalSnapshotCalls, 0);

  let routeRan = false;
  const route = f.scheduler.schedule("ROUTE", async () => {
    routeRan = true;
  });
  await Promise.resolve();
  assert.equal(routeRan, false, "TURN ownership must remain held after [DONE] while write transport is active");

  f.port.snapshot = Object.freeze({
    prepareCount: 1,
    write: Object.freeze({ lifecycle: "FINISHED" as const }),
    response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
  });
  f.sleep.release.resolve();
  const result = await turn;
  await route;
  assert.equal(result.created, false);
  assert.deepEqual(delivered, [
    { type: "TEXT_DELTA", text: "hello" },
    { type: "FINAL_TEXT", text: "hello" },
    { type: "COMPLETED" },
  ]);
  assert.equal(f.port.finalSnapshotCalls, 0);
  assert.equal(routeRan, true);
  assert.equal(f.port.released, true);
});

test("Project turn reuses normalized streaming and returns a newly registered opaque ThreadHandle", async () => {
  const f = await fixture();
  const delivered: ResponseStreamEvent[] = [];
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000020/project");
  const conversationLocator = createConversationLocator(
    "https://chatgpt.com/g/g-p-00000000000000000000000000000020/c/project-conversation",
  );
  f.port.locator = conversationLocator;
  f.port.sendButtonAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "FINISHED" as const }),
      response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
    });
    f.port.responseEvents.push(
      Object.freeze({ type: "TEXT_DELTA" as const, text: "project response" }),
      Object.freeze({ type: "COMPLETED" as const }),
    );
  };

  const result = await f.executor.executeStreaming(
    { kind: "PROJECT", projectLocator },
    "synthetic prompt",
    (event) => delivered.push(event),
  );

  assert.equal(result.created, true);
  assert.deepEqual(f.registry.knownThreads().length, 1);
  assert.throws(() => f.registry.resolve(result.threadHandle), ThreadNotFoundError);
  assert.deepEqual(delivered, [
    { type: "TEXT_DELTA", text: "project response" },
    { type: "FINAL_TEXT", text: "project response" },
    { type: "COMPLETED" },
  ]);
  f.executor.confirmCompletedTurn(result);
  assert.equal(f.registry.resolve(result.threadHandle), conversationLocator);
  assert.deepEqual(f.registry.knownThreads().length, 2);
});

test("failed public Project completion rolls back its provisional handle", async () => {
  const f = await fixture();
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000025/project");
  f.port.locator = createConversationLocator(
    "https://chatgpt.com/g/g-p-00000000000000000000000000000025/c/project-conversation",
  );
  f.port.sendButtonAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "FINISHED" as const }),
      response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
    });
    f.port.responseEvents.push(
      Object.freeze({ type: "TEXT_DELTA" as const, text: "project response" }),
      Object.freeze({ type: "COMPLETED" as const }),
    );
  };

  const result = await f.executor.executeStreaming(
    { kind: "PROJECT", projectLocator },
    "synthetic prompt",
    () => undefined,
  );
  f.executor.rollbackCompletedTurn(result);

  assert.throws(() => f.registry.resolve(result.threadHandle), ThreadNotFoundError);
  assert.equal(f.registry.knownThreads().length, 1);
  await assert.rejects(
    f.scheduler.schedule("TURN", async () => "must-not-run"),
    TurnStateUncertainError,
  );
});

test("Project completion lost during final response delivery latches uncertainty", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const delivered: ResponseStreamEvent[] = [];
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000021/project");
  f.port.locator = createConversationLocator(
    "https://chatgpt.com/g/g-p-00000000000000000000000000000021/c/project-conversation",
  );
  f.port.sendButtonAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "FINISHED" as const }),
      response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
    });
    f.port.responseEvents.push(
      Object.freeze({ type: "TEXT_DELTA" as const, text: "project response" }),
      Object.freeze({ type: "COMPLETED" as const }),
    );
  };

  await assert.rejects(
    f.executor.executeStreaming(
      { kind: "PROJECT", projectLocator },
      "synthetic prompt",
      (event) => {
        delivered.push(event);
        if (event.type === "FINAL_TEXT") abort.abort(new Error("transport closed"));
      },
      abort.signal,
    ),
    TurnStateUncertainError,
  );
  assert.deepEqual(delivered, [
    { type: "TEXT_DELTA", text: "project response" },
    { type: "FINAL_TEXT", text: "project response" },
  ]);
  assert.equal(f.registry.knownThreads().length, 1);
  await assert.rejects(
    f.scheduler.schedule("ROUTE", async () => "must-not-run"),
    TurnStateUncertainError,
  );
});

test("Project registration is rolled back when COMPLETED delivery fails", async () => {
  const f = await fixture();
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000022/project");
  f.port.locator = createConversationLocator(
    "https://chatgpt.com/g/g-p-00000000000000000000000000000022/c/project-conversation",
  );
  f.port.sendButtonAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "FINISHED" as const }),
      response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
    });
    f.port.responseEvents.push(
      Object.freeze({ type: "TEXT_DELTA" as const, text: "project response" }),
      Object.freeze({ type: "COMPLETED" as const }),
    );
  };

  await assert.rejects(
    f.executor.executeStreaming(
      { kind: "PROJECT", projectLocator },
      "synthetic prompt",
      (event) => {
        if (event.type === "COMPLETED") throw new Error("completion delivery failed");
      },
    ),
    TurnStateUncertainError,
  );
  assert.equal(f.registry.knownThreads().length, 1);
});

test("Project response is not delivered before resulting conversation ownership is proven", async () => {
  const f = await fixture();
  const delivered: ResponseStreamEvent[] = [];
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000023/project");
  f.port.locator = createConversationLocator(
    "https://chatgpt.com/g/g-p-00000000000000000000000000000024/c/project-conversation",
  );
  f.port.sendButtonAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "FINISHED" as const }),
      response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
    });
    f.port.responseEvents.push(
      Object.freeze({ type: "TEXT_DELTA" as const, text: "FOREIGN_PROJECT_CANARY" }),
      Object.freeze({ type: "COMPLETED" as const }),
    );
  };

  const turn = f.executor.executeStreaming(
      { kind: "PROJECT", projectLocator },
      "synthetic prompt",
      (event) => delivered.push(event),
    );
  await f.sleep.entered.promise;
  f.sleep.release.resolve();
  await assert.rejects(turn, TurnStateUncertainError);
  assert.deepEqual(delivered, []);
  assert.equal(f.registry.knownThreads().length, 1);
});

test("Project response remains private when an owned route drifts before final authority", async () => {
  const f = await fixture();
  const delivered: ResponseStreamEvent[] = [];
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000023/project");
  f.port.locators.push(
    createConversationLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000023/c/project-conversation"),
    createConversationLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000024/c/project-conversation"),
  );
  f.port.sendButtonAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "FINISHED" as const }),
      response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
    });
    f.port.responseEvents.push(
      Object.freeze({ type: "TEXT_DELTA" as const, text: "DRIFTED_PROJECT_CANARY" }),
      Object.freeze({ type: "COMPLETED" as const }),
    );
  };

  const turn = f.executor.executeStreaming(
    { kind: "PROJECT", projectLocator },
    "synthetic prompt",
    (event) => delivered.push(event),
  );
  await f.sleep.entered.promise;
  f.sleep.release.resolve();
  await assert.rejects(turn, TurnStateUncertainError);
  assert.deepEqual(delivered, []);
  assert.equal(f.registry.knownThreads().length, 1);
});

test("FINAL_TEXT equals the exact concatenation of accepted normalized deltas in arrival order and retains whitespace", async () => {
  const f = await fixture();
  const delivered: ResponseStreamEvent[] = [];
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "FINISHED" as const }),
      response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
    });
    f.port.responseEvents.push(
      Object.freeze({ type: "TEXT_DELTA" as const, text: "  leading" }),
      Object.freeze({ type: "TEXT_DELTA" as const, text: " middle " }),
      Object.freeze({ type: "TEXT_DELTA" as const, text: "trailing\n\n" }),
      Object.freeze({ type: "COMPLETED" as const }),
    );
  };

  const result = await f.executor.executeStreaming(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
    (event) => delivered.push(event),
  );

  assert.equal(result.created, false);
  assert.deepEqual(delivered, [
    { type: "TEXT_DELTA", text: "  leading" },
    { type: "TEXT_DELTA", text: " middle " },
    { type: "TEXT_DELTA", text: "trailing\n\n" },
    { type: "FINAL_TEXT", text: "  leading middle trailing\n\n" },
    { type: "COMPLETED" },
  ]);
});

test("validity rejects all-whitespace response safely without emitting FINAL_TEXT or COMPLETED", async () => {
  const f = await fixture();
  const delivered: ResponseStreamEvent[] = [];
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "FINISHED" as const }),
      response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
    });
    f.port.responseEvents.push(
      Object.freeze({ type: "TEXT_DELTA" as const, text: "   \t" }),
      Object.freeze({ type: "TEXT_DELTA" as const, text: "\n\r  " }),
      Object.freeze({ type: "COMPLETED" as const }),
    );
  };

  await assert.rejects(
    f.executor.executeStreaming(
      { kind: "THREAD", threadHandle: f.handle },
      "synthetic prompt",
      (event) => delivered.push(event),
    ),
    ResponseStreamFailedError,
  );

  assert.deepEqual(delivered, [
    { type: "TEXT_DELTA", text: "   \t" },
    { type: "TEXT_DELTA", text: "\n\r  " },
  ]);
});

test("zero accepted assistant text with semantic completion fails safely", async () => {
  const f = await fixture();
  const delivered: ResponseStreamEvent[] = [];
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "FINISHED" as const }),
      response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
    });
    f.port.responseEvents.push(Object.freeze({ type: "COMPLETED" as const }));
  };

  await assert.rejects(
    f.executor.executeStreaming(
      { kind: "THREAD", threadHandle: f.handle },
      "synthetic prompt",
      (event) => delivered.push(event),
    ),
    ResponseStreamFailedError,
  );

  assert.deepEqual(delivered, []);
});

test("explicit accumulated text bound fails safely on overflow across multiple drains without canary leak", async () => {
  const f = await fixture(new FakeStreamingTurnPort(), new BlockingSleep(), {
    maxAccumulatedTextChars: 15,
  });
  const canary = "RAW_OVERFLOW_SECRET_CANARY_123456789";
  const delivered: ResponseStreamEvent[] = [];

  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "ACTIVE" as const }),
      response: Object.freeze({ lifecycle: "STREAMING" as const, failure: null }),
    });
    f.port.responseEvents.push(Object.freeze({ type: "TEXT_DELTA" as const, text: "0123456789" }));
  };

  const turn = f.executor.executeStreaming(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
    (event) => delivered.push(event),
  );
  await f.sleep.entered.promise;

  assert.deepEqual(delivered, [{ type: "TEXT_DELTA", text: "0123456789" }]);

  // Second drain: appending this delta would exceed 15 chars
  f.port.responseEvents.push(
    Object.freeze({ type: "TEXT_DELTA" as const, text: canary }),
    Object.freeze({ type: "COMPLETED" as const }),
  );
  f.port.snapshot = Object.freeze({
    prepareCount: 1,
    write: Object.freeze({ lifecycle: "FINISHED" as const }),
    response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
  });
  f.sleep.release.resolve();

  let captured: unknown;
  try {
    await turn;
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof ResponseStreamFailedError);
  assert.equal(captured.message.includes(canary), false);
  assert.equal(JSON.stringify(captured).includes(canary), false);
  assert.equal(delivered.some((e) => "text" in e && e.text.includes(canary)), false);
  assert.equal(delivered.some((e) => e.type === "FINAL_TEXT" || e.type === "COMPLETED"), false);
});

test("M6 parse failure waits for safe M5 settlement and does not latch TURN_STATE_UNCERTAIN", async () => {
  const f = await fixture();
  const delivered: ResponseStreamEvent[] = [];
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "ACTIVE" as const }),
      response: Object.freeze({ lifecycle: "FAILED" as const, failure: "PARSE_FAILED" as const }),
    });
    f.port.responseEvents.push(Object.freeze({ type: "TEXT_DELTA" as const, text: "valid-prefix" }));
  };
  const turn = f.executor.executeStreaming(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
    (event) => delivered.push(event),
  );
  const isSettled = settledState(turn);
  await f.sleep.entered.promise;
  assert.equal(isSettled(), false, "normalization failure must not abandon active write safety observation");
  assert.deepEqual(delivered, [{ type: "TEXT_DELTA", text: "valid-prefix" }]);
  assert.equal(f.port.discarded, true);

  f.port.snapshot = Object.freeze({
    prepareCount: 1,
    write: Object.freeze({ lifecycle: "FINISHED" as const }),
    response: Object.freeze({ lifecycle: "FAILED" as const, failure: "PARSE_FAILED" as const }),
  });
  f.sleep.release.resolve();
  await assert.rejects(turn, ResponseParseFailedError);
  assert.equal(f.port.finalSnapshotCalls, 0);

  let routeRan = false;
  await f.scheduler.schedule("ROUTE", async () => {
    routeRan = true;
  });
  assert.equal(routeRan, true, "M6 parse failure must not poison scheduler mutation state");
});

test("M5 write failure dominates an M6 response failure", async () => {
  const f = await fixture();
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "FAILED" as const }),
      response: Object.freeze({ lifecycle: "FAILED" as const, failure: "PARSE_FAILED" as const }),
    });
  };
  await assert.rejects(
    f.executor.executeStreaming(
      { kind: "THREAD", threadHandle: f.handle },
      "synthetic prompt",
      () => undefined,
    ),
    TurnWriteFailedError,
  );
  assert.equal(f.port.finalSnapshotCalls, 0);
});

test("write FINISHED before [DONE] waits for semantic completion under bounded deadline", async () => {
  const f = await fixture();
  const delivered: ResponseStreamEvent[] = [];
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "FINISHED" as const }),
      response: Object.freeze({ lifecycle: "STREAMING" as const, failure: null }),
    });
    f.port.responseEvents.push(Object.freeze({ type: "TEXT_DELTA" as const, text: "partial" }));
  };

  const turn = f.executor.executeStreaming(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
    (event) => delivered.push(event),
  );
  const isSettled = settledState(turn);
  await f.sleep.entered.promise;

  assert.deepEqual(delivered, [{ type: "TEXT_DELTA", text: "partial" }]);
  assert.equal(isSettled(), false, "must wait for semantic [DONE] even after write is FINISHED");

  f.port.responseEvents.push(
    Object.freeze({ type: "TEXT_DELTA" as const, text: " end" }),
    Object.freeze({ type: "COMPLETED" as const }),
  );
  f.port.snapshot = Object.freeze({
    prepareCount: 1,
    write: Object.freeze({ lifecycle: "FINISHED" as const }),
    response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
  });
  f.sleep.release.resolve();

  const result = await turn;
  assert.equal(result.created, false);
  assert.deepEqual(delivered, [
    { type: "TEXT_DELTA", text: "partial" },
    { type: "TEXT_DELTA", text: " end" },
    { type: "FINAL_TEXT", text: "partial end" },
    { type: "COMPLETED" },
  ]);
});

test("transport completion without [DONE] surfaces safe RESPONSE_STREAM_FAILED", async () => {
  const f = await fixture();
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "FINISHED" as const }),
      response: Object.freeze({ lifecycle: "FAILED" as const, failure: "INCOMPLETE" as const }),
    });
  };

  await assert.rejects(
    f.executor.executeStreaming(
      { kind: "THREAD", threadHandle: f.handle },
      "synthetic prompt",
      () => undefined,
    ),
    ResponseStreamFailedError,
  );
});

test("listener throws on TEXT_DELTA fails safely without text leak", async () => {
  const f = await fixture();
  const canary = "RAW_LISTENER_DELTA_CANARY";
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "FINISHED" as const }),
      response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
    });
    f.port.responseEvents.push(
      Object.freeze({ type: "TEXT_DELTA" as const, text: canary }),
      Object.freeze({ type: "COMPLETED" as const }),
    );
  };

  let captured: unknown;
  try {
    await f.executor.executeStreaming(
      { kind: "THREAD", threadHandle: f.handle },
      "synthetic prompt",
      () => {
        throw new Error("listener boom");
      },
    );
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof ResponseStreamFailedError);
  assert.equal(captured.message.includes(canary), false);
  assert.equal(JSON.stringify(captured).includes(canary), false);
});

test("listener throws on FINAL_TEXT fails safely", async () => {
  const f = await fixture();
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "FINISHED" as const }),
      response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
    });
    f.port.responseEvents.push(
      Object.freeze({ type: "TEXT_DELTA" as const, text: "ok" }),
      Object.freeze({ type: "COMPLETED" as const }),
    );
  };

  await assert.rejects(
    f.executor.executeStreaming(
      { kind: "THREAD", threadHandle: f.handle },
      "synthetic prompt",
      (event) => {
        if (event.type === "FINAL_TEXT") {
          throw new Error("final text listener error");
        }
      },
    ),
    ResponseStreamFailedError,
  );
});

test("listener throws on COMPLETED fails safely", async () => {
  const f = await fixture();
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "FINISHED" as const }),
      response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
    });
    f.port.responseEvents.push(
      Object.freeze({ type: "TEXT_DELTA" as const, text: "ok" }),
      Object.freeze({ type: "COMPLETED" as const }),
    );
  };

  await assert.rejects(
    f.executor.executeStreaming(
      { kind: "THREAD", threadHandle: f.handle },
      "synthetic prompt",
      (event) => {
        if (event.type === "COMPLETED") {
          throw new Error("completed listener error");
        }
      },
    ),
    ResponseStreamFailedError,
  );
});

test("caller cancellation after Enter commit stops response delivery and final reconciliation but retains M5 safety observation until settlement", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const delivered: ResponseStreamEvent[] = [];
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "ACTIVE" as const }),
      response: Object.freeze({ lifecycle: "STREAMING" as const, failure: null }),
    });
  };

  const turn = f.executor.executeStreaming(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
    (event) => delivered.push(event),
    abort.signal,
  );
  const isSettled = settledState(turn);
  await f.sleep.entered.promise;
  abort.abort(new Error("caller stopped waiting"));
  f.port.responseEvents.push(
    Object.freeze({ type: "TEXT_DELTA" as const, text: "must-not-deliver" }),
    Object.freeze({ type: "COMPLETED" as const }),
  );

  let routeRan = false;
  const route = f.scheduler.schedule("ROUTE", async () => {
    routeRan = true;
  });
  await Promise.resolve();
  assert.equal(routeRan, false);
  assert.equal(isSettled(), false);

  f.port.snapshot = Object.freeze({
    prepareCount: 1,
    write: Object.freeze({ lifecycle: "FINISHED" as const }),
    response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
  });
  f.sleep.release.resolve();
  await assert.rejects(turn, OperationAbortedError);
  await route;
  assert.deepEqual(delivered, []);
  assert.equal(f.port.discarded, true);
  assert.equal(f.port.finalSnapshotCalls, 0);
  assert.equal(routeRan, true);
});

test("runtime-generation replacement invalidates response work and releases the scoped observation", async () => {
  const f = await fixture();
  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "ACTIVE" as const }),
      response: Object.freeze({ lifecycle: "STREAMING" as const, failure: null }),
    });
  };

  const turn = f.executor.executeStreaming(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
    () => undefined,
  );
  await f.sleep.entered.promise;
  f.port.runtime!.observe({ pid: 601, creationTime: "m6-turn-replaced" });
  f.port.responseEvents.push(Object.freeze({ type: "TEXT_DELTA" as const, text: "stale" }));
  f.sleep.release.resolve();

  await assert.rejects(turn, RuntimeGenerationChangedError);
  assert.equal(f.port.released, true, "finally must release and dispose the stale scoped response observation");
});

test("streaming succeeds when TurnCdpPort does not implement rendered-DOM snapshot methods", async () => {
  const f = await fixture();
  const minimalPort: TurnCdpPort = {
    getTurnComposerState: f.port.getTurnComposerState.bind(f.port),
    armTurnObservation: f.port.armTurnObservation.bind(f.port),
    getTurnObservation: f.port.getTurnObservation.bind(f.port),
    takeTurnResponseEvents: f.port.takeTurnResponseEvents.bind(f.port),
    discardTurnResponse: f.port.discardTurnResponse.bind(f.port),
    releaseTurnObservation: f.port.releaseTurnObservation.bind(f.port),
    insertText: f.port.insertText.bind(f.port),
    clickExistingTurnSendButton: f.port.clickExistingTurnSendButton.bind(f.port),
    dispatchEnterKeyDown: f.port.dispatchEnterKeyDown.bind(f.port),
    dispatchEnterKeyUp: f.port.dispatchEnterKeyUp.bind(f.port),
    getCurrentConversationLocator: f.port.getCurrentConversationLocator.bind(f.port),
  };
  const executor = new TurnExecutor(
    f.registry,
    f.scheduler,
    new NoopPreflight(),
    minimalPort,
    { commandTimeoutMs: 100, writeObservationTimeoutMs: 100, writeSettlementTimeoutMs: 100 },
  );

  f.port.keyDownAction = () => {
    f.port.snapshot = Object.freeze({
      prepareCount: 1,
      write: Object.freeze({ lifecycle: "FINISHED" as const }),
      response: Object.freeze({ lifecycle: "COMPLETED" as const, failure: null }),
    });
    f.port.responseEvents.push(
      Object.freeze({ type: "TEXT_DELTA" as const, text: "minimal-port-success" }),
      Object.freeze({ type: "COMPLETED" as const }),
    );
  };

  const delivered: ResponseStreamEvent[] = [];
  const result = await executor.executeStreaming(
    { kind: "THREAD", threadHandle: f.handle },
    "synthetic prompt",
    (event) => delivered.push(event),
  );

  assert.equal(result.created, false);
  assert.deepEqual(delivered, [
    { type: "TEXT_DELTA", text: "minimal-port-success" },
    { type: "FINAL_TEXT", text: "minimal-port-success" },
    { type: "COMPLETED" },
  ]);
});

test("streaming is rejected before commit when the TurnCdpPort lacks takeTurnResponseEvents or discardTurnResponse", async () => {
  const f = await fixture();
  const legacyPort: TurnCdpPort = {
    getTurnComposerState: f.port.getTurnComposerState.bind(f.port),
    armTurnObservation: f.port.armTurnObservation.bind(f.port),
    getTurnObservation: f.port.getTurnObservation.bind(f.port),
    releaseTurnObservation: f.port.releaseTurnObservation.bind(f.port),
    insertText: f.port.insertText.bind(f.port),
    dispatchEnterKeyDown: f.port.dispatchEnterKeyDown.bind(f.port),
    dispatchEnterKeyUp: f.port.dispatchEnterKeyUp.bind(f.port),
    getCurrentConversationLocator: f.port.getCurrentConversationLocator.bind(f.port),
  };
  const executor = new TurnExecutor(
    f.registry,
    f.scheduler,
    new NoopPreflight(),
    legacyPort,
    { commandTimeoutMs: 100, writeObservationTimeoutMs: 100, writeSettlementTimeoutMs: 100 },
  );
  await assert.rejects(
    executor.executeStreaming(
      { kind: "THREAD", threadHandle: f.handle },
      "synthetic prompt",
      () => undefined,
    ),
    ResponseStreamUnavailableError,
  );
});
