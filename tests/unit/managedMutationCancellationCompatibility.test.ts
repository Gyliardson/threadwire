import assert from "node:assert/strict";
import test from "node:test";
import { CdpSessionManager, CdpTargetDiscoveryLike } from "../../src/cdp/CdpSessionManager.js";
import { ChromeRemoteInterfaceSession } from "../../src/cdp/ChromeRemoteInterfaceSession.js";
import { ChromeRemoteInterfaceTransport } from "../../src/cdp/ChromeRemoteInterfaceTransport.js";
import { MutationGuardedChromeRemoteInterfaceSession } from "../../src/cdp/MutationGuardedChromeRemoteInterfaceSession.js";
import {
  CdpTransport,
  CdpTransportConnectOptions,
  CdpTransportSession,
} from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { RuntimeGenerationTracker } from "../../src/domain/RuntimeGeneration.js";
import { ExistingReadinessSnapshot, RouteExpectation } from "../../src/readiness/types.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";

const config = {
  cdpHost: "127.0.0.1" as const,
  cdpPort: 9223,
  classicPolicy: "MANAGED" as const,
};

const target: CdpTargetInfo = {
  id: "managed-compat-target",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/managed-compat-target",
  url: "https://chatgpt.com/",
};

class StaticDiscovery implements CdpTargetDiscoveryLike {
  public async findPrimaryTarget(): Promise<CdpTargetInfo> {
    return target;
  }
}

class ManagedSession implements CdpTransportSession {
  public navigateSignals: Array<AbortSignal | undefined> = [];
  public reloadSignals: Array<AbortSignal | undefined> = [];
  public focusSignals: Array<AbortSignal | undefined> = [];
  public insertSignals: Array<AbortSignal | undefined> = [];
  public keyDownSignals: Array<AbortSignal | undefined> = [];
  public keyUpSignals: Array<AbortSignal | undefined> = [];

  public async close(): Promise<void> {}
  public onDisconnect(_listener: () => void): () => void {
    return () => undefined;
  }
  public async initializeReadinessObservation(): Promise<void> {}
  public async navigate(_url: string, signal?: AbortSignal): Promise<void> {
    this.navigateSignals.push(signal);
  }
  public async reload(signal?: AbortSignal): Promise<void> {
    this.reloadSignals.push(signal);
  }
  public async getReadinessSnapshot(
    _expectedRoute: RouteExpectation,
  ): Promise<ExistingReadinessSnapshot> {
    return {} as ExistingReadinessSnapshot;
  }
  public async focusBackendNode(_backendDOMNodeId: number, signal?: AbortSignal): Promise<void> {
    this.focusSignals.push(signal);
  }
  public async getTurnComposerState(_expectedRoute: RouteExpectation) {
    return { expectedRoute: true, eligible: true, focused: true, empty: true };
  }
  public armTurnObservation() {
    return Object.freeze({});
  }
  public getTurnObservation(_handle: unknown) {
    return { prepareCount: 0, write: null };
  }
  public releaseTurnObservation(_handle: unknown): void {}
  public async insertText(_text: string, signal?: AbortSignal): Promise<void> {
    this.insertSignals.push(signal);
  }
  public async dispatchEnterKeyDown(signal?: AbortSignal): Promise<void> {
    this.keyDownSignals.push(signal);
  }
  public async dispatchEnterKeyUp(signal?: AbortSignal): Promise<void> {
    this.keyUpSignals.push(signal);
  }
  public async getCurrentConversationLocator(): Promise<null> {
    return null;
  }
}

class ProbeTransport implements CdpTransport {
  public readonly session = new ManagedSession();
  public beforeMutationSupplied = false;

  public async connect(options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    this.beforeMutationSupplied = options.beforeMutation !== undefined;
    return this.session;
  }
}

function runtime(): RuntimeGenerationTracker {
  const value = new RuntimeGenerationTracker();
  value.observe({ pid: 100, creationTime: "2026-09-02T12:00:00.0000000Z" });
  return value;
}

function fakeCriClient() {
  return {
    close: async () => undefined,
    on: (_event: "disconnect", _listener: () => void) => undefined,
    Page: {
      navigate: async (_params: { url: string }) => ({}),
      reload: async (_params: { ignoreCache?: boolean } = {}) => undefined,
      getFrameTree: async () => ({ frameTree: { frame: { id: "main", url: "https://chatgpt.com/" } } }),
    },
    Accessibility: {
      getFullAXTree: async (_params: { frameId: string }) => ({ nodes: [] }),
    },
    DOM: {
      focus: async (_params: { backendNodeId: number }) => undefined,
    },
    Input: {
      insertText: async (_params: { text: string }) => undefined,
      dispatchKeyEvent: async (_params: Readonly<Record<string, unknown>>) => undefined,
    },
    Runtime: {
      evaluate: async (_params: Readonly<Record<string, unknown>>) => ({ result: { value: false } }),
      callFunctionOn: async (_params: Readonly<Record<string, unknown>>) => ({ result: { value: false } }),
    },
    Network: {
      enable: async (_options: Record<string, unknown>) => undefined,
      requestWillBeSent: (_listener: (event: never) => void) => () => undefined,
      responseReceived: (_listener: (event: never) => void) => () => undefined,
      loadingFinished: (_listener: (event: never) => void) => () => undefined,
      loadingFailed: (_listener: (event: never) => void) => () => undefined,
    },
  };
}

test("managed ChromeRemoteInterfaceTransport uses the ordinary unwrapped session", async () => {
  const client = fakeCriClient();
  const transport = new ChromeRemoteInterfaceTransport({ connect: async () => client });
  const session = await transport.connect({
    host: config.cdpHost,
    port: config.cdpPort,
    target,
  });

  assert.equal(session instanceof ChromeRemoteInterfaceSession, true);
  assert.equal(session instanceof MutationGuardedChromeRemoteInterfaceSession, false);
  await session.close();
});

test("managed manager supplies no provenance mutation hook", async () => {
  const tracker = runtime();
  const transport = new ProbeTransport();
  const manager = new CdpSessionManager(config, tracker, {
    discovery: new StaticDiscovery(),
    transport,
    attachTimeoutMs: 100,
  });

  await manager.connect();
  assert.equal(transport.beforeMutationSupplied, false);
});

test("new optional ordinary mutation signals are inert at the managed raw boundary", async () => {
  const tracker = runtime();
  const lease = tracker.getCurrentRuntimeLease();
  const transport = new ProbeTransport();
  const manager = new CdpSessionManager(config, tracker, {
    discovery: new StaticDiscovery(),
    transport,
    attachTimeoutMs: 100,
  });
  await manager.connect();

  const aborted = new AbortController();
  aborted.abort(new Error("synthetic bound-only authority"));

  await manager.insertText("synthetic", lease, aborted.signal);
  await manager.dispatchEnterKeyDown(lease, aborted.signal);
  await manager.dispatchEnterKeyUp(lease, aborted.signal);

  assert.deepEqual(transport.session.insertSignals, [undefined]);
  assert.deepEqual(transport.session.keyDownSignals, [undefined]);
  assert.deepEqual(transport.session.keyUpSignals, [undefined]);
});

test("managed route raw primitives retain baseline signal forwarding behavior", async () => {
  const tracker = runtime();
  const lease = tracker.getCurrentRuntimeLease();
  const transport = new ProbeTransport();
  const manager = new CdpSessionManager(config, tracker, {
    discovery: new StaticDiscovery(),
    transport,
    attachTimeoutMs: 100,
  });
  await manager.connect();

  const active = new AbortController();
  await manager.navigate("https://chatgpt.com/", active.signal);
  await manager.reload(active.signal);
  await manager.focusBackendNode(501, lease, active.signal);

  assert.deepEqual(transport.session.navigateSignals, [undefined]);
  assert.deepEqual(transport.session.reloadSignals, [undefined]);
  assert.deepEqual(transport.session.focusSignals, [undefined]);
});

test("active scheduler cancellation retains baseline queue-release behavior", async () => {
  const tracker = runtime();
  const scheduler = new OperationScheduler(tracker);
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstStarted = false;
  let secondStarted = false;

  const first = scheduler.schedule(
    "TURN",
    async () => {
      firstStarted = true;
      await gate;
      return "first";
    },
    { signal: controller.signal },
  );
  const second = scheduler.schedule("TURN", async () => {
    secondStarted = true;
    return "second";
  });

  await Promise.resolve();
  assert.equal(firstStarted, true);
  assert.equal(secondStarted, false);

  controller.abort(new Error("synthetic active cancellation"));
  await Promise.resolve();
  assert.equal(secondStarted, false);

  release();
  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.equal(secondStarted, true);
});
