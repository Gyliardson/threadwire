import assert from "node:assert/strict";
import test from "node:test";
import { CdpSessionManager, CdpTargetDiscoveryLike } from "../../src/cdp/CdpSessionManager.js";
import {
  CdpTransport,
  CdpTransportConnectOptions,
  CdpTransportSession,
} from "../../src/cdp/CdpTransport.js";
import { ChromeRemoteInterfaceTransport } from "../../src/cdp/ChromeRemoteInterfaceTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { RuntimeGenerationTracker, RuntimeLease } from "../../src/domain/RuntimeGeneration.js";
import {
  CdpNavigationFailedError,
  RouteNavigationFailedError,
} from "../../src/domain/errors.js";
import { ConversationLocator, createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import { ExistingReadinessSnapshot, RouteExpectation } from "../../src/readiness/types.js";
import {
  ConversationNavigationPort,
  ConversationReadinessPort,
  ConversationRouter,
} from "../../src/routing/ConversationRouter.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";
import { ThreadRegistry } from "../../src/routing/ThreadRegistry.js";

const canaryLocator = createConversationLocator("https://chatgpt.com/c/LOCATOR_SECRET_CANARY");
const target: CdpTargetInfo = {
  id: "m5-navigation-sanitization",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/m5-navigation-sanitization",
  url: "https://chatgpt.com/",
};
const config = { cdpHost: "127.0.0.1" as const, cdpPort: 9223 };

function createRawNavigateProtocolError(locator: ConversationLocator): Error {
  const raw = new Error("ProtocolError: Page.navigate failed") as Error & Record<string, unknown>;
  raw.request = {
    method: "Page.navigate",
    params: { url: locator },
  };
  raw.response = {
    code: -32000,
    message: "Synthetic protocol failure",
  };
  raw.sessionId = "SESSION_ID_SECRET_CANARY";
  (raw as Error & { cause?: unknown }).cause = {
    command: "Page.navigate",
    params: { url: locator },
  };
  return raw;
}

function graphContains(value: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof value === "string") {
    return value.includes(needle);
  }
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (value instanceof Error) {
    if (value.name.includes(needle) || value.message.includes(needle)) {
      return true;
    }
    if ("cause" in value && graphContains((value as Error & { cause?: unknown }).cause, needle, seen)) {
      return true;
    }
  }

  for (const nested of Object.values(value as Record<string, unknown>)) {
    if (graphContains(nested, needle, seen)) {
      return true;
    }
  }
  return false;
}

function graphContainsIdentity(value: unknown, targetValue: unknown, seen = new Set<unknown>()): boolean {
  if (value === targetValue) {
    return true;
  }
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (value instanceof Error && "cause" in value) {
    if (graphContainsIdentity((value as Error & { cause?: unknown }).cause, targetValue, seen)) {
      return true;
    }
  }
  return Object.values(value as Record<string, unknown>).some((nested) =>
    graphContainsIdentity(nested, targetValue, seen),
  );
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  let rejected = false;
  let captured: unknown;
  try {
    await operation();
  } catch (error) {
    rejected = true;
    captured = error;
  }
  assert.equal(rejected, true, "operation must reject");
  return captured;
}

class Discovery implements CdpTargetDiscoveryLike {
  public async findPrimaryTarget(): Promise<CdpTargetInfo> {
    return target;
  }
}

class NoopReadiness implements ConversationReadinessPort {
  public existingCalls = 0;

  public async waitForExistingRoute(
    _expectedLocator: ConversationLocator,
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<void> {
    this.existingCalls += 1;
  }

  public async waitForFreshRoute(
    _lease: RuntimeLease,
    _signal?: AbortSignal,
  ): Promise<void> {}
}

class NavigateFailingCriClient {
  public readonly rawError = createRawNavigateProtocolError(canaryLocator);
  public navigateUrl: string | null = null;
  private readonly disconnectListeners = new Set<() => void>();

  public readonly Page = {
    enable: async () => ({}),
    loadEventFired: (_listener: () => void) => () => undefined,
    frameStoppedLoading: (_listener: (event: { frameId: string }) => void) => () => undefined,
    navigate: async ({ url }: { url: string }) => {
      this.navigateUrl = url;
      throw this.rawError;
    },
    reload: async (_params: { ignoreCache?: boolean } = {}) => ({}),
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
    focus: async (_params: { backendNodeId: number }) => undefined,
  };

  public readonly Input = {
    insertText: async (_params: { text: string }) => undefined,
    dispatchKeyEvent: async (_params: Record<string, unknown>) => undefined,
  };

  public readonly Network = {
    enable: async (_options: Record<string, unknown>) => undefined,
    requestWillBeSent: (_listener: (event: unknown) => void) => () => undefined,
    responseReceived: (_listener: (event: unknown) => void) => () => undefined,
    loadingFinished: (_listener: (event: unknown) => void) => () => undefined,
    loadingFailed: (_listener: (event: unknown) => void) => () => undefined,
  };

  public async close(): Promise<void> {}

  public on(event: "disconnect", listener: () => void): void {
    if (event === "disconnect") {
      this.disconnectListeners.add(listener);
    }
  }
}

function createRuntime(): RuntimeGenerationTracker {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 900, creationTime: "m5-navigation-sanitization" });
  return runtime;
}

test("route-to-thread strips raw Page.navigate ProtocolError locator data through adapter, manager, and router", async () => {
  const runtime = createRuntime();
  const client = new NavigateFailingCriClient();
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new Discovery(),
    transport: new ChromeRemoteInterfaceTransport({ connect: async () => client }),
    attachTimeoutMs: 100,
  });
  await manager.connect();

  const scheduler = new OperationScheduler(runtime);
  const registry = new ThreadRegistry({ handleFactory: () => "navigation_canary_handle" });
  const handle = registry.register(canaryLocator);
  const readiness = new NoopReadiness();
  const router = new ConversationRouter(registry, scheduler, manager, readiness);

  const outward = await captureError(() => router.routeToThread(handle));

  assert.ok(outward instanceof RouteNavigationFailedError);
  assert.equal(outward.code, "ROUTE_NAVIGATION_FAILED");
  assert.equal(client.navigateUrl, canaryLocator, "locator is resolved internally for legitimate Page.navigate");
  assert.equal(readiness.existingCalls, 0, "readiness must not run after navigation command failure");
  assert.equal(graphContains(outward, "LOCATOR_SECRET_CANARY"), false);
  assert.equal(graphContains(outward, "SESSION_ID_SECRET_CANARY"), false);
  assert.equal(graphContainsIdentity(outward, client.rawError), false);

  const cause = (outward as Error & { cause?: unknown }).cause;
  assert.ok(cause instanceof CdpNavigationFailedError);
  assert.equal((cause as Error & { cause?: unknown }).cause, undefined);
});

class UnsafeNavigationSession implements CdpTransportSession {
  public constructor(public readonly rawError: Error) {}

  public async close(): Promise<void> {}
  public onDisconnect(_listener: () => void): () => void {
    return () => undefined;
  }
  public async initializeReadinessObservation(): Promise<void> {}
  public async navigate(_url: string): Promise<void> {
    throw this.rawError;
  }
  public async reload(): Promise<void> {
    throw this.rawError;
  }
  public async getReadinessSnapshot(
    _expectedRoute: RouteExpectation,
  ): Promise<ExistingReadinessSnapshot> {
    return {
      mainFrame: { frameId: "main", loaderId: "loader", expectedRoute: true },
      eligibleEditables: [],
      backendActivity: { activeCount: 0, activityEpoch: 0 },
    };
  }
  public async focusBackendNode(_backendDOMNodeId: number): Promise<void> {}
}

class UnsafeNavigationTransport implements CdpTransport {
  public readonly session = new UnsafeNavigationSession(createRawNavigateProtocolError(canaryLocator));

  public async connect(_options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    return this.session;
  }
}

test("CdpSessionManager defense-in-depth discards an unsanitized adapter navigation error", async () => {
  const runtime = createRuntime();
  const transport = new UnsafeNavigationTransport();
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new Discovery(),
    transport,
    attachTimeoutMs: 100,
  });
  await manager.connect();

  const outward = await captureError(() => manager.navigate(canaryLocator));
  assert.ok(outward instanceof CdpNavigationFailedError);
  assert.equal(outward.code, "CDP_NAVIGATION_FAILED");
  assert.equal(graphContains(outward, "LOCATOR_SECRET_CANARY"), false);
  assert.equal(graphContainsIdentity(outward, transport.session.rawError), false);
});

class PrewrappedUnsafeNavigation implements ConversationNavigationPort {
  public readonly rawError = createRawNavigateProtocolError(canaryLocator);

  public async navigate(_url: string, _signal?: AbortSignal): Promise<void> {
    throw new RouteNavigationFailedError(undefined, { cause: this.rawError });
  }

  public async reload(_signal?: AbortSignal): Promise<void> {
    throw new RouteNavigationFailedError(undefined, { cause: this.rawError });
  }

  public async navigateAndWaitForLoadSettlement(
    _url: string,
    _expectedRoute: unknown,
    _signal?: AbortSignal,
  ): Promise<void> {
    throw new RouteNavigationFailedError(undefined, { cause: this.rawError });
  }
}

test("ConversationRouter strips unsafe cause graphs even from prewrapped route errors", async () => {
  const runtime = createRuntime();
  const scheduler = new OperationScheduler(runtime);
  const registry = new ThreadRegistry({ handleFactory: () => "prewrapped_navigation_handle" });
  const handle = registry.register(canaryLocator);
  const navigation = new PrewrappedUnsafeNavigation();
  const router = new ConversationRouter(registry, scheduler, navigation, new NoopReadiness());

  const outward = await captureError(() => router.routeToThread(handle));
  assert.ok(outward instanceof RouteNavigationFailedError);
  assert.equal(outward.code, "ROUTE_NAVIGATION_FAILED");
  assert.equal(graphContains(outward, "LOCATOR_SECRET_CANARY"), false);
  assert.equal(graphContainsIdentity(outward, navigation.rawError), false);
  assert.equal((outward as Error & { cause?: unknown }).cause, undefined);
});
