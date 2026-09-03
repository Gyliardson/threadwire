import assert from "node:assert/strict";
import test from "node:test";
import { BoundCdpSessionManager } from "../../src/cdp/BoundCdpSessionManager.js";
import { CdpTargetDiscoveryLike } from "../../src/cdp/CdpSessionManager.js";
import { ChromeRemoteInterfaceTransport } from "../../src/cdp/ChromeRemoteInterfaceTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { RuntimeGenerationTracker, RuntimeLease } from "../../src/domain/RuntimeGeneration.js";
import { OperationAbortedError, OperationTimeoutError } from "../../src/domain/errors.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";
import { RuntimeProvenanceGuard } from "../../src/runtime/BoundRuntimeProvenanceGuard.js";
import { withTimeout } from "../../src/utils/timeout.js";

const config = {
  cdpHost: "127.0.0.1" as const,
  cdpPort: 9223,
  classicPolicy: "BOUND_EXISTING" as const,
};
const target: CdpTargetInfo = {
  id: "primitive-cancellation-target",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/primitive-cancellation-target",
  url: "https://chatgpt.com/",
};

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function flushDetachedContinuation(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class StaticDiscovery implements CdpTargetDiscoveryLike {
  public async findPrimaryTarget(): Promise<CdpTargetInfo> {
    return target;
  }
}

class BlockableGuard implements RuntimeProvenanceGuard {
  public calls = 0;
  private blockAt: number | null = null;
  private started: Deferred | null = null;
  private releaseGate: Deferred | null = null;

  public async bind(_lease: RuntimeLease, _signal?: AbortSignal): Promise<void> {}

  public async assertCurrent(_lease: RuntimeLease, _signal?: AbortSignal): Promise<void> {
    this.calls += 1;
    if (this.blockAt !== this.calls) {
      return;
    }
    this.started?.resolve();
    await this.releaseGate?.promise;
  }

  public blockOnFutureCall(offset: number): Readonly<{
    started: Promise<void>;
    release(): void;
  }> {
    const started = deferred();
    const releaseGate = deferred();
    this.blockAt = this.calls + offset;
    this.started = started;
    this.releaseGate = releaseGate;
    return Object.freeze({
      started: started.promise,
      release: () => releaseGate.resolve(),
    });
  }
}

class PrimitiveCriClient {
  public pageNavigateCalls = 0;
  public pageReloadCalls = 0;
  public focusCalls = 0;
  public insertTextCalls = 0;
  public keyDownCalls = 0;
  public keyUpCalls = 0;
  private readonly disconnectListeners = new Set<() => void>();

  public readonly Page = {
    navigate: async (_params: { url: string }) => {
      this.pageNavigateCalls += 1;
      return {};
    },
    reload: async (_params: { ignoreCache?: boolean } = {}) => {
      this.pageReloadCalls += 1;
    },
    getFrameTree: async () => ({
      frameTree: {
        frame: { id: "main", loaderId: "loader", url: "https://chatgpt.com/" },
      },
    }),
  };

  public readonly Accessibility = {
    getFullAXTree: async (_params: { frameId: string }) => ({ nodes: [] }),
  };

  public readonly DOM = {
    focus: async (_params: { backendNodeId: number }) => {
      this.focusCalls += 1;
    },
  };

  public readonly Input = {
    insertText: async (_params: { text: string }) => {
      this.insertTextCalls += 1;
    },
    dispatchKeyEvent: async ({ type }: { type: string }) => {
      if (type === "keyDown") this.keyDownCalls += 1;
      if (type === "keyUp") this.keyUpCalls += 1;
    },
  };

  public readonly Runtime = {
    evaluate: async (_params: Readonly<Record<string, unknown>>) => ({ result: { value: false } }),
    callFunctionOn: async (_params: Readonly<Record<string, unknown>>) => ({ result: { value: false } }),
  };

  public readonly Network = {
    enable: async (_options: Record<string, unknown>) => undefined,
    requestWillBeSent: (_listener: (event: never) => void) => () => undefined,
    responseReceived: (_listener: (event: never) => void) => () => undefined,
    loadingFinished: (_listener: (event: never) => void) => () => undefined,
    loadingFailed: (_listener: (event: never) => void) => () => undefined,
  };

  public async close(): Promise<void> {}

  public on(event: "disconnect", listener: () => void): void {
    if (event === "disconnect") this.disconnectListeners.add(listener);
  }
}

async function fixture() {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 100, creationTime: "2026-09-02T12:00:00.0000000Z" });
  const lease = runtime.getCurrentRuntimeLease();
  const guard = new BlockableGuard();
  const client = new PrimitiveCriClient();
  const transport = new ChromeRemoteInterfaceTransport({ connect: async () => client });
  const manager = new BoundCdpSessionManager(config, runtime, guard, {
    discovery: new StaticDiscovery(),
    transport,
    attachTimeoutMs: 100,
  });
  await manager.bindExistingRuntime(lease);
  return { runtime, lease, guard, client, manager };
}

type PrimitiveCase = Readonly<{
  name: string;
  run(
    manager: BoundCdpSessionManager,
    lease: RuntimeLease,
    signal: AbortSignal,
  ): Promise<void>;
  count(client: PrimitiveCriClient): number;
}>;

const primitiveCases: readonly PrimitiveCase[] = [
  {
    name: "Input.insertText",
    run: async (manager, lease, signal) => await manager.insertText("synthetic", lease, signal),
    count: (client) => client.insertTextCalls,
  },
  {
    name: "Input.dispatchKeyEvent keyDown",
    run: async (manager, lease, signal) => await manager.dispatchEnterKeyDown(lease, signal),
    count: (client) => client.keyDownCalls,
  },
  {
    name: "Input.dispatchKeyEvent keyUp",
    run: async (manager, lease, signal) => await manager.dispatchEnterKeyUp(lease, signal),
    count: (client) => client.keyUpCalls,
  },
  {
    name: "Page.navigate",
    run: async (manager, _lease, signal) => await manager.navigate("https://chatgpt.com/", signal),
    count: (client) => client.pageNavigateCalls,
  },
  {
    name: "Page.reload",
    run: async (manager, _lease, signal) => await manager.reload(signal),
    count: (client) => client.pageReloadCalls,
  },
  {
    name: "DOM.focus",
    run: async (manager, lease, signal) => await manager.focusBackendNode(501, lease, signal),
    count: (client) => client.focusCalls,
  },
];

for (const primitive of primitiveCases) {
  test(`bound ${primitive.name} cannot start after its owning command timeout`, async () => {
    const f = await fixture();
    const block = f.guard.blockOnFutureCall(2);
    const operation = withTimeout(
      async (commandSignal) => await primitive.run(f.manager, f.lease, commandSignal),
      20,
    );

    await block.started;
    await assert.rejects(operation, OperationTimeoutError);
    assert.equal(primitive.count(f.client), 0);

    block.release();
    await flushDetachedContinuation();
    assert.equal(primitive.count(f.client), 0);
  });
}

test("caller abort linked to command authority blocks detached raw mutation", async () => {
  const f = await fixture();
  const scheduler = new OperationScheduler(f.runtime);
  const controller = new AbortController();
  const block = f.guard.blockOnFutureCall(2);

  const operation = scheduler.schedule(
    "TURN",
    async (operationSignal, lease) =>
      await withTimeout(
        async (commandSignal) => await f.manager.insertText("synthetic", lease, commandSignal),
        1_000,
        operationSignal ? { signal: operationSignal } : {},
      ),
    { signal: controller.signal },
  );

  await block.started;
  controller.abort(new Error("synthetic caller cancellation"));
  await assert.rejects(operation, OperationAbortedError);
  assert.equal(f.client.insertTextCalls, 0);

  block.release();
  await flushDetachedContinuation();
  assert.equal(f.client.insertTextCalls, 0);
});

test("scheduler can advance after timeout without allowing the detached old raw write", async () => {
  const f = await fixture();
  const scheduler = new OperationScheduler(f.runtime);
  const block = f.guard.blockOnFutureCall(2);
  let nextOperationStarted = false;

  const oldOperation = scheduler.schedule(
    "TURN",
    async (_operationSignal, lease) =>
      await withTimeout(
        async (commandSignal) => await f.manager.insertText("old", lease, commandSignal),
        20,
      ),
  );

  await block.started;
  const nextOperation = scheduler.schedule("TURN", async () => {
    nextOperationStarted = true;
  });

  await assert.rejects(oldOperation, OperationTimeoutError);
  await nextOperation;
  assert.equal(nextOperationStarted, true);
  assert.equal(f.client.insertTextCalls, 0);

  block.release();
  await flushDetachedContinuation();
  assert.equal(f.client.insertTextCalls, 0);
});
