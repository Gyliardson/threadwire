import assert from "node:assert/strict";
import test from "node:test";
import { ChromeRemoteInterfaceTransport } from "../../src/cdp/ChromeRemoteInterfaceTransport.js";
import { CdpNavigationSettlementTransportSession } from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { RouteExpectation } from "../../src/readiness/types.js";
import { OperationAbortedError } from "../../src/domain/errors.js";

const target: CdpTargetInfo = {
  id: "target-settlement",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/target-settlement",
  url: "https://chatgpt.com/",
};

const freshRoute: RouteExpectation = {
  kind: "FRESH_ROOT",
};

class FakeSettlementCriClient {
  public frame = {
    id: "main-frame-123",
    loaderId: "loader-123",
    url: "https://chatgpt.com/",
  };

  public readonly operations: string[] = [];
  public loadEventListeners = new Set<() => void>();
  public frameStoppedListeners = new Set<(event: { frameId: string }) => void>();
  public unsubsCalled = 0;

  public enableFails = false;
  public navigateFails = false;
  public getFrameTreeFails = false;
  public returnDifferentFrameId = false;
  public emitLifecycleDuringEnable = false;

  public readonly Page = {
    enable: async () => {
      this.operations.push("Page.enable");
      if (this.enableFails) {
        throw new Error("SECRET_ENABLE_FAILURE_INTERNAL");
      }
      if (this.emitLifecycleDuringEnable) {
        this.emitLoadEvent();
        this.emitFrameStopped(this.frame.id);
      }
      return {};
    },
    loadEventFired: (listener: () => void) => {
      this.operations.push("Page.loadEventFired.arm");
      this.loadEventListeners.add(listener);
      return () => {
        this.unsubsCalled += 1;
        this.loadEventListeners.delete(listener);
      };
    },
    frameStoppedLoading: (listener: (event: { frameId: string }) => void) => {
      this.operations.push("Page.frameStoppedLoading.arm");
      this.frameStoppedListeners.add(listener);
      return () => {
        this.unsubsCalled += 1;
        this.frameStoppedListeners.delete(listener);
      };
    },
    navigate: async (_params: { url: string }) => {
      this.operations.push("Page.navigate");
      if (this.navigateFails) {
        throw new Error("SECRET_NAVIGATE_FAILURE_INTERNAL");
      }
      return {
        frameId: this.returnDifferentFrameId ? "different-frame" : this.frame.id,
        loaderId: this.frame.loaderId,
      };
    },
    reload: async (_params: { ignoreCache?: boolean } = {}) => {
      this.operations.push("Page.reload");
      return {};
    },
    getFrameTree: async () => {
      this.operations.push("Page.getFrameTree");
      if (this.getFrameTreeFails) {
        throw new Error("SECRET_GETFRAMETREE_FAILURE_INTERNAL");
      }
      return { frameTree: { frame: this.frame } };
    },
  };

  public readonly Accessibility = {
    getFullAXTree: async () => ({ nodes: [] }),
  };

  public readonly DOM = {
    focus: async () => undefined,
  };

  public readonly Input = {
    insertText: async () => undefined,
    dispatchKeyEvent: async () => undefined,
  };

  public readonly Network = {
    enable: async () => undefined,
    requestWillBeSent: () => () => undefined,
    responseReceived: () => () => undefined,
    loadingFinished: () => () => undefined,
    loadingFailed: () => () => undefined,
  };

  public async close(): Promise<void> {}
  public on(_event: string, _listener: () => void): void {}

  public emitLoadEvent(): void {
    for (const listener of this.loadEventListeners) {
      listener();
    }
  }

  public emitFrameStopped(frameId: string): void {
    for (const listener of this.frameStoppedListeners) {
      listener({ frameId });
    }
  }
}

async function createSession(client: FakeSettlementCriClient): Promise<CdpNavigationSettlementTransportSession> {
  const transport = new ChromeRemoteInterfaceTransport({
    connect: async () => client,
  });
  return (await transport.connect({
    host: "127.0.0.1",
    port: 9223,
    target,
  })) as CdpNavigationSettlementTransportSession;
}

test("lifecycle subscriptions are armed before Page.enable and Page.navigate", async () => {
  const client = new FakeSettlementCriClient();
  const session = await createSession(client);

  const navPromise = session.navigateAndWaitForLoadSettlement("https://chatgpt.com/", freshRoute);

  await new Promise((resolve) => setImmediate(resolve));

  const armLoadIdx = client.operations.indexOf("Page.loadEventFired.arm");
  const armFrameIdx = client.operations.indexOf("Page.frameStoppedLoading.arm");
  const enableIdx = client.operations.indexOf("Page.enable");
  const navIdx = client.operations.indexOf("Page.navigate");

  assert.ok(armLoadIdx !== -1 && armLoadIdx < enableIdx, "loadEvent listener must arm before Page.enable");
  assert.ok(armFrameIdx !== -1 && armFrameIdx < enableIdx, "frameStopped listener must arm before Page.enable");
  assert.ok(enableIdx < navIdx, "Page.enable must occur before Page.navigate");

  // Emit settlement events to resolve
  client.emitLoadEvent();
  client.emitFrameStopped(client.frame.id);

  await navPromise;
});

test("operation does NOT settle after loadEventFired alone", async () => {
  const client = new FakeSettlementCriClient();
  const session = await createSession(client);

  let settled = false;
  const navPromise = session.navigateAndWaitForLoadSettlement("https://chatgpt.com/", freshRoute).then(() => {
    settled = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  client.emitLoadEvent();

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false, "Must not settle with loadEventFired alone");

  client.emitFrameStopped(client.frame.id);
  await navPromise;
  assert.equal(settled, true);
});

test("operation does NOT settle after frameStoppedLoading for a different frameId", async () => {
  const client = new FakeSettlementCriClient();
  const session = await createSession(client);

  let settled = false;
  const navPromise = session.navigateAndWaitForLoadSettlement("https://chatgpt.com/", freshRoute).then(() => {
    settled = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  client.emitLoadEvent();
  client.emitFrameStopped("unrelated-iframe-id");

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false, "Must not settle with non-matching frameStoppedLoading");

  client.emitFrameStopped(client.frame.id);
  await navPromise;
  assert.equal(settled, true);
});

test("operation does NOT settle after matching events while route is not yet expected", async () => {
  const client = new FakeSettlementCriClient();
  client.frame.url = "https://chatgpt.com/c/other-route";
  const session = await createSession(client);

  let settled = false;
  const navPromise = session.navigateAndWaitForLoadSettlement("https://chatgpt.com/", freshRoute).then(() => {
    settled = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  client.emitLoadEvent();
  client.emitFrameStopped(client.frame.id);

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settled, false, "Must not settle when route is not confirmed expected");

  client.frame.url = "https://chatgpt.com/";
  await navPromise;
  assert.equal(settled, true);
});

test("operation settles immediately once load event, matching frame stop, and expected route are all satisfied", async () => {
  const client = new FakeSettlementCriClient();
  const session = await createSession(client);

  const navPromise = session.navigateAndWaitForLoadSettlement("https://chatgpt.com/", freshRoute);

  await new Promise((resolve) => setImmediate(resolve));
  client.emitLoadEvent();
  client.emitFrameStopped(client.frame.id);

  await navPromise;
  assert.ok(client.operations.includes("Page.getFrameTree"));
});

test("listener unsubscribe functions are called on success", async () => {
  const client = new FakeSettlementCriClient();
  const session = await createSession(client);

  const navPromise = session.navigateAndWaitForLoadSettlement("https://chatgpt.com/", freshRoute);

  await new Promise((resolve) => setImmediate(resolve));
  client.emitLoadEvent();
  client.emitFrameStopped(client.frame.id);

  await navPromise;
  assert.equal(client.unsubsCalled, 2, "Both listeners must be unsubscribed on success");
  assert.equal(client.loadEventListeners.size, 0);
  assert.equal(client.frameStoppedListeners.size, 0);
});

test("listener unsubscribe functions are called on failure", async () => {
  const client = new FakeSettlementCriClient();
  client.navigateFails = true;
  const session = await createSession(client);

  await assert.rejects(
    session.navigateAndWaitForLoadSettlement("https://chatgpt.com/", freshRoute),
    /CDP Page\.navigate command failed/,
  );

  assert.equal(client.unsubsCalled, 2, "Both listeners must be unsubscribed on failure");
  assert.equal(client.loadEventListeners.size, 0);
  assert.equal(client.frameStoppedListeners.size, 0);
});

test("listener unsubscribe functions are called on parent AbortSignal cancellation", async () => {
  const client = new FakeSettlementCriClient();
  const session = await createSession(client);

  const controller = new AbortController();
  const navPromise = session.navigateAndWaitForLoadSettlement("https://chatgpt.com/", freshRoute, controller.signal);

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(navPromise, OperationAbortedError);
  assert.equal(client.unsubsCalled, 2, "Both listeners must be unsubscribed on abort");
  assert.equal(client.loadEventListeners.size, 0);
  assert.equal(client.frameStoppedListeners.size, 0);
});

test("raw Page protocol errors are sanitized and do not leak internal metadata", async () => {
  const client = new FakeSettlementCriClient();
  client.enableFails = true;
  const session = await createSession(client);

  await assert.rejects(
    session.navigateAndWaitForLoadSettlement("https://chatgpt.com/", freshRoute),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("SECRET_ENABLE_FAILURE_INTERNAL"));
      return true;
    },
  );
});

test("stale lifecycle events emitted before Page.navigate initiation do not satisfy settlement", async () => {
  const client = new FakeSettlementCriClient();
  client.emitLifecycleDuringEnable = true;
  const session = await createSession(client);

  let settled = false;
  const navPromise = session.navigateAndWaitForLoadSettlement("https://chatgpt.com/", freshRoute).then(() => {
    settled = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(settled, false, "Must not settle from stale pre-navigation lifecycle events");

  client.emitLoadEvent();
  client.emitFrameStopped(client.frame.id);

  await navPromise;
  assert.equal(settled, true);
});
