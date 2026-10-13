import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ChromeRemoteInterfaceTransport } from "../../src/cdp/ChromeRemoteInterfaceTransport.js";
import { CriClient } from "../../src/cdp/ChromeRemoteInterfaceHelpers.js";
import {
  observeBlockingNotice,
  noticeClickPoint,
  ReadinessCandidateChangedError,
} from "../../src/cdp/KnownFreshNotice.js";
import {
  FreshNoticeBudget,
  FRESH_NOTICE_INTENT_SCHEMA,
} from "../../src/readiness/FreshNoticeBudget.js";
import { RuntimeGenerationTracker } from "../../src/domain/RuntimeGeneration.js";
import {
  CdpReadinessFailedError,
  OperationAbortedError,
  FreshRouteReadinessTimeoutError,
  TurnStateUncertainError,
} from "../../src/domain/errors.js";
import { BoundCdpSessionManager } from "../../src/cdp/BoundCdpSessionManager.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";
import { ReadinessController } from "../../src/readiness/ReadinessController.js";
import { ExistingReadinessPolicy } from "../../src/readiness/ExistingReadinessPolicy.js";
import { FreshReadinessPolicy } from "../../src/readiness/FreshReadinessPolicy.js";
import { loadConfig } from "../../src/config/ControllerConfig.js";

type AxNode = Awaited<
  ReturnType<CriClient["Accessibility"]["getFullAXTree"]>
>["nodes"][number];
const composer = {
  nodeId: "composer",
  ignored: false,
  role: { type: "role", value: "textbox" },
  backendDOMNodeId: 101,
  properties: [
    { name: "multiline", value: { value: true } },
    { name: "focusable", value: { value: true } },
    { name: "editable", value: { value: "richtext" } },
  ],
} as AxNode;
function notice(): AxNode[] {
  return [
    {
      nodeId: "dialog",
      ignored: false,
      role: { type: "role", value: "dialog" },
      backendDOMNodeId: 201,
      childIds: ["heading", "close", "upgrade"],
    },
    {
      nodeId: "heading",
      ignored: false,
      role: { type: "role", value: "heading" },
      name: { type: "string", value: "Conheça o novo ChatGPT" },
    },
    {
      nodeId: "close",
      ignored: false,
      role: { type: "role", value: "button" },
      name: { type: "string", value: "Fechar" },
      backendDOMNodeId: 202,
    },
    {
      nodeId: "upgrade",
      ignored: false,
      role: { type: "role", value: "button" },
      name: { type: "string", value: "Fazer upgrade agora" },
      backendDOMNodeId: 203,
    },
  ] as AxNode[];
}
const target = {
  id: "synthetic",
  title: "ChatGPT",
  type: "page",
  description: "",
  url: "https://chatgpt.com/",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/synthetic",
};

class NoticeClient {
  public nodes = notice();
  public loaderId = "loader";
  public hit = 202;
  public readonly events: string[] = [];
  public onMouse: ((type: string) => void) | undefined;
  public readonly Page = {
    navigate: async () => ({}),
    reload: async () => undefined,
    getFrameTree: async () => ({
      frameTree: {
        frame: {
          id: "main",
          loaderId: this.loaderId,
          url: "https://chatgpt.com/",
        },
      },
    }),
    getLayoutMetrics: async () => ({
      cssVisualViewport: { clientWidth: 800, clientHeight: 600 },
    }),
  };
  public readonly Accessibility = {
    getFullAXTree: async () => {
      this.events.push("ax");
      return { nodes: this.nodes };
    },
  };
  public readonly DOM = {
    describeNode: async () => ({
      node: { nodeName: "BUTTON", nodeType: 1, backendNodeId: 202 },
    }),
    getContentQuads: async () => ({
      quads: [[10, 10, 30, 10, 30, 30, 10, 30]],
    }),
    getNodeForLocation: async () => {
      this.events.push("hit");
      return { backendNodeId: this.hit, frameId: "main" };
    },
    focus: async () => {
      this.events.push("focus");
    },
  };
  public readonly Input = {
    insertText: async () => undefined,
    dispatchKeyEvent: async () => undefined,
    dispatchMouseEvent: async ({ type }: { type: string }) => {
      this.events.push(type);
      this.onMouse?.(type);
      if (type === "mouseReleased") this.nodes = [composer];
    },
  };
  public readonly Runtime = {};
  public readonly Network = {
    enable: async () => undefined,
    requestWillBeSent: () => () => undefined,
    responseReceived: () => () => undefined,
    loadingFinished: () => () => undefined,
    loadingFailed: () => () => undefined,
  };
  public async close(): Promise<void> {}
  public on(): void {}
  public removeListener(): void {}
}
async function connected(
  client: NoticeClient,
  hook: () => Promise<void> = async () => {
    client.events.push("provenance");
  },
) {
  const session = await new ChromeRemoteInterfaceTransport({
    connect: async () => client,
  }).connect({
    host: "127.0.0.1",
    port: 9223,
    target,
    beforeMutation: hook,
  });
  await session.initializeReadinessObservation();
  return session;
}

test("only the exact known notice qualifies; auth, ambiguous, disabled and malformed dialogs do not", () => {
  assert.deepEqual(observeBlockingNotice(notice()), {
    kind: "KNOWN_FRESH_NOTICE",
    dialogId: 201,
    closeButtonId: 202,
  });
  assert.equal(observeBlockingNotice([composer]).kind, "ABSENT");
  for (const change of [
    (n: AxNode[]) => {
      n[1]!.name = { type: "string", value: "Sign in" };
    },
    (n: AxNode[]) => {
      n.push({ ...n[0]!, nodeId: "another" });
    },
    (n: AxNode[]) => {
      n[2]!.properties = [
        { name: "disabled", value: { type: "boolean", value: true } },
      ];
    },
    (n: AxNode[]) => {
      n[0]!.childIds = ["missing"];
    },
    (n: AxNode[]) => {
      n[0]!.childIds = ["dialog"];
    },
  ]) {
    const nodes = notice();
    change(nodes);
    assert.equal(observeBlockingNotice(nodes).kind, "UNKNOWN");
  }
  assert.throws(
    () => noticeClickPoint([[0, 0, 0, 0, 0, 0, 0, 0]], 800, 600),
    CdpReadinessFailedError,
  );
  assert.throws(
    () => noticeClickPoint([[0, 0, 900, 0, 900, 10, 0, 10]], 800, 600),
    CdpReadinessFailedError,
  );
});

test("actual production mouse guard validates provenance and live hit before each of exactly two events", async () => {
  const client = new NoticeClient();
  const session = await connected(client);
  const snapshot = await session.getReadinessSnapshot({ kind: "FRESH_ROOT" });
  let consumed = 0;
  let possible = 0;
  await session.dismissKnownFreshNotice!(
    snapshot,
    () => {
      consumed++;
      client.events.push("consume");
    },
    () => {
      possible++;
      client.events.push("possible");
    },
    new AbortController().signal,
  );
  assert.equal(consumed, 1);
  assert.equal(possible, 2);
  for (const type of ["mousePressed", "mouseReleased"]) {
    const index = client.events.indexOf(type);
    assert.deepEqual(client.events.slice(index - 2, index), [
      "hit",
      "possible",
    ]);
    assert.equal(
      client.events.slice(0, index).filter((e) => e === "provenance").length,
      type === "mousePressed" ? 1 : 2,
    );
  }
  assert.equal(client.events.filter((e) => e === "mousePressed").length, 1);
  assert.equal(client.events.filter((e) => e === "mouseReleased").length, 1);
  assert.ok(
    client.events.indexOf("consume") < client.events.indexOf("mousePressed"),
  );
  assert.equal(
    (await session.getReadinessSnapshot({ kind: "FRESH_ROOT" })).blockingNotice
      ?.kind,
    "ABSENT",
  );
});

test("slow provenance followed by document drift or cancellation cannot enter the first mouse operation", async () => {
  for (const cancel of [false, true]) {
    const client = new NoticeClient();
    const abort = new AbortController();
    const session = await connected(client, async () => {
      if (cancel) abort.abort();
      else client.loaderId = "replacement";
    });
    const snapshot = await session.getReadinessSnapshot({ kind: "FRESH_ROOT" });
    let consumed = 0;
    await assert.rejects(() =>
      session.dismissKnownFreshNotice!(
        snapshot,
        () => {
          consumed++;
        },
        () => undefined,
        abort.signal,
      ),
    );
    assert.equal(consumed, 0);
    assert.equal(
      client.events.some((e) => e.startsWith("mouse")),
      false,
    );
  }
});

test("occlusion consumes the budget but permits no input; partial press does not blindly release", async () => {
  for (const partial of [false, true]) {
    const client = new NoticeClient();
    const abort = new AbortController();
    if (partial) client.onMouse = () => abort.abort();
    else client.hit = 203;
    const session = await connected(client);
    const snapshot = await session.getReadinessSnapshot({ kind: "FRESH_ROOT" });
    let consumed = 0;
    let possible = 0;
    await assert.rejects(
      () =>
        session.dismissKnownFreshNotice!(
          snapshot,
          () => {
            consumed++;
          },
          () => {
            possible++;
          },
          abort.signal,
        ),
      partial ? OperationAbortedError : CdpReadinessFailedError,
    );
    assert.equal(consumed, 1);
    assert.equal(possible, partial ? 1 : 0);
    assert.equal(client.events.includes("mouseReleased"), false);
  }
});

test("composer focus rechecks live eligibility after provenance and rejects a newly visible notice before DOM.focus", async () => {
  const client = new NoticeClient();
  client.nodes = [composer];
  const session = await connected(client, async () => {
    client.nodes = notice();
  });
  await session.getReadinessSnapshot({ kind: "FRESH_ROOT" });
  await assert.rejects(
    () => session.focusBackendNode(101),
    ReadinessCandidateChangedError,
  );
  assert.equal(client.events.includes("focus"), false);
});

test("exclusive UUID ledger binds the root and survives reentry, parallel instances and restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "threadwire-notice-test-"));
  try {
    const intent = randomUUID();
    const authority = randomUUID();
    const tracker = new RuntimeGenerationTracker();
    tracker.observe({ pid: 42, creationTime: "2026-10-13T00:00:00.1234560Z" });
    const lease = tracker.getCurrentRuntimeLease();
    const document = { frameId: "main", loaderId: "loader" };
    const record = {
      schema: FRESH_NOTICE_INTENT_SCHEMA,
      authority,
      intent,
      scope: "DISMISS_KNOWN_FRESH_NOTICE_ONCE",
      rootPid: 42,
      rootCreationTime: lease.identity.creationTime,
    };
    const path = join(directory, `${intent}.json`);
    writeFileSync(path, JSON.stringify(record));
    const first = new FreshNoticeBudget(intent, directory);
    const concurrent = new FreshNoticeBudget(intent, directory);
    tracker.observe({ pid: 43, creationTime: lease.identity.creationTime });
    assert.throws(
      () => first.consume(tracker.getCurrentRuntimeLease(), document),
      CdpReadinessFailedError,
    );
    first.consume(lease, document);
    assert.throws(
      () => first.consume(lease, document),
      CdpReadinessFailedError,
    );
    assert.throws(() => concurrent.consume(lease, document));
    assert.throws(
      () => new FreshNoticeBudget(intent, directory).consume(lease, document),
      CdpReadinessFailedError,
    );
    const consumed = JSON.parse(
      readFileSync(join(directory, `${intent}.consumed.json`), "utf8"),
    );
    assert.equal(consumed.state, "CONSUMED_NONREPLAYABLE");
    assert.equal(consumed.authority, authority);
    assert.deepEqual(consumed.document, document);
    assert.deepEqual(consumed.runtimeLease, lease);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("authority bytes cannot change between admission and consumption", () => {
  const directory = mkdtempSync(join(tmpdir(), "threadwire-notice-test-"));
  try {
    const intent = randomUUID();
    const tracker = new RuntimeGenerationTracker();
    tracker.observe({ pid: 42, creationTime: "2026-10-13T00:00:00.1234560Z" });
    const path = join(directory, `${intent}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        schema: FRESH_NOTICE_INTENT_SCHEMA,
        authority: randomUUID(),
        intent,
        scope: "DISMISS_KNOWN_FRESH_NOTICE_ONCE",
        rootPid: 42,
        rootCreationTime:
          tracker.getCurrentRuntimeLease().identity.creationTime,
      }),
    );
    const budget = new FreshNoticeBudget(intent, directory);
    writeFileSync(path, "{}");
    assert.throws(
      () =>
        budget.consume(tracker.getCurrentRuntimeLease(), {
          frameId: "main",
          loaderId: "loader",
        }),
      CdpReadinessFailedError,
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("actual manager and scheduler poison the same runtime after a partial notice click", async () => {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 42, creationTime: "A" });
  const scheduler = new OperationScheduler(runtime);
  const client = new NoticeClient();
  const abort = new AbortController();
  client.onMouse = () => abort.abort();
  let consumed = 0;
  const manager = new BoundCdpSessionManager(
    { cdpHost: "127.0.0.1", cdpPort: 9223, classicPolicy: "BOUND_EXISTING" },
    runtime,
    { bind: async () => undefined, assertCurrent: async () => undefined },
    {
      discovery: { findPrimaryTarget: async () => target },
      transport: { connect: async () => await connected(client) },
      freshNoticeBudget: {
        consume: () => {
          consumed++;
        },
      },
      onReadinessMutationUncertain: (lease) =>
        scheduler.markRuntimeMutationStateUncertain(lease),
    },
  );
  await manager.bindExistingRuntime(runtime.getCurrentRuntimeLease());
  await manager.connect();
  const lease = runtime.getCurrentRuntimeLease();
  const snapshot = await manager.getReadinessSnapshot(
    { kind: "FRESH_ROOT" },
    lease,
  );
  await assert.rejects(
    () =>
      scheduler.schedule("ROUTE", async () => {
        await manager.dismissKnownFreshNotice(snapshot, lease, abort.signal);
      }),
    TurnStateUncertainError,
  );
  assert.equal(consumed, 1);
  assert.deepEqual(
    client.events.filter((e) => e.startsWith("mouse")),
    ["mousePressed"],
  );
  let nextStarted = false;
  await assert.rejects(
    () =>
      scheduler.schedule("TURN", () => {
        nextStarted = true;
      }),
    TurnStateUncertainError,
  );
  assert.equal(nextStarted, false);
});

test("dismissal forces new observations and the full original 500 ms fresh guard without restarting its deadline", async () => {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 42, creationTime: "A" });
  let known = true;
  let time = 0;
  let dismissedAt = -1;
  let dismissals = 0;
  let focusCalls = 0;
  const deadlines: number[] = [];
  const observation = {
    getReadinessSnapshot: async () => ({
      mainFrame: { frameId: "main", loaderId: "loader", expectedRoute: true },
      eligibleEditables: [{ backendDOMNodeId: 101, focused: true }],
      backendActivity: { activeCount: 0, activityEpoch: 0 },
      blockingNotice: known
        ? {
            kind: "KNOWN_FRESH_NOTICE" as const,
            dialogId: 201,
            closeButtonId: 202,
          }
        : { kind: "ABSENT" as const },
    }),
    focusBackendNode: async () => {
      assert.equal(known, false);
      focusCalls++;
    },
    dismissKnownFreshNotice: async () => {
      dismissals++;
      known = false;
      dismissedAt = time;
    },
  };
  const controller = new ReadinessController(
    observation,
    new ExistingReadinessPolicy({
      frameStableObservations: 1,
      focusStableObservations: 1,
    }),
    new FreshReadinessPolicy({
      frameStableObservations: 1,
      focusStableObservations: 1,
      clock: () => time,
    }),
    {
      sleep: async (ms) => {
        time += ms;
      },
      deadlineScheduler: {
        schedule: (_callback, ms) => {
          deadlines.push(ms);
          return 1;
        },
        cancel: () => undefined,
      },
    },
  );
  await controller.waitForFreshRoute(runtime.getCurrentRuntimeLease());
  assert.equal(dismissals, 1);
  assert.equal(focusCalls, 1);
  assert.ok(time - dismissedAt >= 500);
  assert.deepEqual(deadlines, [20000]);
});

test("unknown dialog has no input and remains bounded by the original readiness deadline", async () => {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 42, creationTime: "A" });
  let expire!: () => void;
  let inputs = 0;
  const controller = new ReadinessController(
    {
      getReadinessSnapshot: async () => ({
        mainFrame: { frameId: "main", loaderId: "loader", expectedRoute: true },
        eligibleEditables: [{ backendDOMNodeId: 101, focused: false }],
        backendActivity: { activeCount: 0, activityEpoch: 0 },
        blockingNotice: { kind: "UNKNOWN" },
      }),
      focusBackendNode: async () => {
        inputs++;
      },
      dismissKnownFreshNotice: async () => {
        inputs++;
      },
    },
    undefined,
    undefined,
    {
      sleep: async () => expire(),
      deadlineScheduler: {
        schedule: (callback) => {
          expire = callback;
          return 1;
        },
        cancel: () => undefined,
      },
    },
  );
  await assert.rejects(
    () => controller.waitForFreshRoute(runtime.getCurrentRuntimeLease()),
    FreshRouteReadinessTimeoutError,
  );
  assert.equal(inputs, 0);
});

test("notice handling is disabled by default and only canonical intent UUIDs in BOUND_EXISTING are admitted", () => {
  assert.equal(loadConfig({}).knownFreshNoticeIntent, undefined);
  assert.throws(() =>
    loadConfig({ THREADWIRE_KNOWN_FRESH_NOTICE_INTENT: randomUUID() }),
  );
  assert.throws(() =>
    loadConfig({
      THREADWIRE_CLASSIC_POLICY: "BOUND_EXISTING",
      THREADWIRE_KNOWN_FRESH_NOTICE_INTENT: "../other",
    }),
  );
  const intent = randomUUID();
  assert.equal(
    loadConfig({
      THREADWIRE_CLASSIC_POLICY: "BOUND_EXISTING",
      THREADWIRE_KNOWN_FRESH_NOTICE_INTENT: intent,
    }).knownFreshNoticeIntent,
    intent,
  );
});
