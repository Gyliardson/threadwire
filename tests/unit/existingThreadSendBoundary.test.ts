import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { CdpSessionManager, CdpTargetDiscoveryLike } from "../../src/cdp/CdpSessionManager.js";
import { ChromeRemoteInterfaceTransport } from "../../src/cdp/ChromeRemoteInterfaceTransport.js";
import {
  CdpTransport,
  CdpTransportConnectOptions,
  CdpTurnObservationHandle,
  CdpTurnTransportSession,
} from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import {
  CdpDisconnectedError,
  OperationAbortedError,
  RuntimeGenerationChangedError,
} from "../../src/domain/errors.js";
import { RuntimeGenerationTracker } from "../../src/domain/RuntimeGeneration.js";
import { ConversationLocator, createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import { ExistingReadinessSnapshot, RouteExpectation } from "../../src/readiness/types.js";

const ROUTE = "https://chatgpt.com/c/synthetic-existing-send";
const OTHER_ROUTE = "https://chatgpt.com/c/synthetic-existing-other";
const locator = createConversationLocator(ROUTE);
const target: CdpTargetInfo = {
  id: "target-existing-send",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/target-existing-send",
  url: ROUTE,
};
const config = { cdpHost: "127.0.0.1" as const, cdpPort: 9223 };

class FakeHTMLElement {
  public offsetParent: object | null = {};
  public textContent = "";
  public innerHTML = "";
  public ownerForm: FakeHTMLFormElement | null = null;
  private readonly attributes = new Map<string, string>();

  public matches(selector: string): boolean {
    return selector.includes('[contenteditable="true"]') && this.getAttribute("contenteditable") === "true";
  }

  public closest(selector: string): FakeHTMLFormElement | null {
    return selector === "form" ? this.ownerForm : null;
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeHTMLInputElement extends FakeHTMLElement {
  public value = "";

  public override matches(selector: string): boolean {
    return selector.includes("input") || super.matches(selector);
  }
}

class FakeHTMLTextAreaElement extends FakeHTMLElement {
  public value = "";

  public override matches(selector: string): boolean {
    return selector.includes("textarea") || super.matches(selector);
  }
}

class FakeHTMLFormElement extends FakeHTMLElement {
  public sendCandidates: FakeHTMLElement[] = [];

  public querySelectorAll(selector: string): FakeHTMLElement[] {
    return selector === 'button[data-testid="send-button"]' ? [...this.sendCandidates] : [];
  }
}

class FakeHTMLButtonElement extends FakeHTMLElement {
  public disabled = false;
  public clickCount = 0;

  public constructor(public form: FakeHTMLFormElement | null) {
    super();
  }

  public click(): void {
    this.clickCount += 1;
  }
}

type ComposerMode = "TEXT" | "CONTENTEDITABLE";
type RuntimeArgument = Readonly<{ value?: unknown; objectId?: string }>;
type RuntimeCall = Readonly<{
  objectId?: string;
  functionDeclaration?: string;
  arguments?: readonly RuntimeArgument[];
  returnByValue?: boolean;
}>;

function axComposer(value: unknown): Record<string, unknown> {
  return {
    ignored: false,
    role: { value: "textbox" },
    backendDOMNodeId: 501,
    value: { value },
    properties: [
      { name: "multiline", value: { value: true } },
      { name: "focusable", value: { value: true } },
      { name: "editable", value: { value: "richtext" } },
      { name: "focused", value: { value: true } },
    ],
  };
}

class ExecutableExistingSendCriClient {
  public frame = { id: "main", loaderId: "loader", url: ROUTE };
  public readonly form = new FakeHTMLFormElement();
  public readonly alternateForm = new FakeHTMLFormElement();
  public readonly composer: FakeHTMLElement;
  public readonly wrongComposer = new FakeHTMLTextAreaElement();
  public readonly document: { activeElement: FakeHTMLElement | null };
  public readonly buttons: FakeHTMLButtonElement[] = [];
  public axNodes: readonly unknown[] = [];
  public beforeRuntimeCall: ((callNumber: number) => void) | null = null;
  public resolveError: Error | null = null;
  public axError: Error | null = null;
  public releaseError: Error | null = null;
  public readonly runtimeErrors = new Map<number, Error>();
  public readonly callFunctionCalls: RuntimeCall[] = [];
  public readonly releaseObjectCalls: string[] = [];
  public closeCalls = 0;

  private readonly objectsById = new Map<string, FakeHTMLElement>();
  private readonly idsByObject = new Map<FakeHTMLElement, string>();

  public constructor(mode: ComposerMode, text: string) {
    if (mode === "TEXT") {
      const composer = new FakeHTMLTextAreaElement();
      composer.value = text;
      this.composer = composer;
    } else {
      const composer = new FakeHTMLElement();
      composer.setAttribute("contenteditable", "true");
      composer.innerHTML = "<p>stable-composer-html</p>";
      this.composer = composer;
      this.axNodes = [axComposer(text.replaceAll("\n", "\n\n"))];
    }
    this.composer.ownerForm = this.form;
    this.wrongComposer.ownerForm = this.form;
    this.document = { activeElement: this.composer };
    this.registerObject("composer-501", this.composer);
    this.registerObject("composer-999", this.wrongComposer);
    this.registerObject("form-601", this.form);
    this.registerObject("form-602", this.alternateForm);
  }

  public addEligibleSend(form: FakeHTMLFormElement = this.form): FakeHTMLButtonElement {
    const button = new FakeHTMLButtonElement(form);
    form.sendCandidates.push(button);
    this.buttons.push(button);
    return button;
  }

  public addGenericSend(form: FakeHTMLFormElement = this.form): FakeHTMLElement {
    const candidate = new FakeHTMLElement();
    form.sendCandidates.push(candidate);
    return candidate;
  }

  public totalClicks(): number {
    return this.buttons.reduce((sum, button) => sum + button.clickCount, 0);
  }

  public readonly Page = {
    navigate: async (_params: { url: string }) => ({}),
    reload: async (_params: { ignoreCache?: boolean } = {}) => undefined,
    getFrameTree: async () => ({ frameTree: { frame: this.frame } }),
  };

  public readonly Accessibility = {
    getFullAXTree: async (_params: { frameId: string }) => {
      if (this.axError !== null) throw this.axError;
      return { nodes: this.axNodes };
    },
  };

  public readonly DOM = {
    focus: async (_params: { backendNodeId: number }) => undefined,
    resolveNode: async ({ backendNodeId }: { backendNodeId: number }) => {
      if (this.resolveError !== null) throw this.resolveError;
      if (backendNodeId === 501) return { object: { objectId: "composer-501" } };
      if (backendNodeId === 999) return { object: { objectId: "composer-999" } };
      if (backendNodeId === 777) return { object: {} };
      return { object: { objectId: `unknown-${backendNodeId}` } };
    },
    describeNode: async ({ objectId }: { objectId: string }) => ({
      node: { backendNodeId: objectId === "form-601" ? 601 : 602 },
    }),
  };

  public readonly Input = {
    insertText: async (_params: { text: string }) => undefined,
    dispatchKeyEvent: async (_params: Record<string, unknown>) => undefined,
  };

  public readonly Runtime = {
    evaluate: async (_params: Record<string, unknown>) => ({ result: { value: false } }),
    callFunctionOn: async (params: RuntimeCall) => {
      const callNumber = this.callFunctionCalls.length + 1;
      this.beforeRuntimeCall?.(callNumber);
      this.callFunctionCalls.push(params);
      const runtimeError = this.runtimeErrors.get(callNumber);
      if (runtimeError !== undefined) throw runtimeError;

      const receiver = typeof params.objectId === "string" ? this.objectsById.get(params.objectId) : undefined;
      if (receiver === undefined) throw new Error("SYNTHETIC_UNKNOWN_OBJECT_INTERNAL");
      if (typeof params.functionDeclaration !== "string") throw new Error("SYNTHETIC_MISSING_DECLARATION_INTERNAL");

      const route = new URL(this.frame.url);
      const context = {
        URL,
        HTMLElement: FakeHTMLElement,
        HTMLInputElement: FakeHTMLInputElement,
        HTMLTextAreaElement: FakeHTMLTextAreaElement,
        HTMLFormElement: FakeHTMLFormElement,
        HTMLButtonElement: FakeHTMLButtonElement,
        document: this.document,
        location: {
          origin: route.origin,
          pathname: route.pathname,
          search: route.search,
          hash: route.hash,
        },
      };
      const fn = runInNewContext(`(${params.functionDeclaration})`, context) as (...args: unknown[]) => unknown;
      const args = (params.arguments ?? []).map((argument) =>
        typeof argument.objectId === "string" ? this.objectsById.get(argument.objectId) : argument.value,
      );
      const value = fn.apply(receiver, args);
      if (params.returnByValue === false && value instanceof FakeHTMLElement) {
        const objectId = this.idsByObject.get(value);
        return objectId === undefined ? { result: { value: null } } : { result: { objectId } };
      }
      return { result: { value } };
    },
    releaseObject: async ({ objectId }: { objectId: string }) => {
      this.releaseObjectCalls.push(objectId);
      if (this.releaseError !== null) throw this.releaseError;
    },
  };

  public readonly Network = {
    enable: async (_params: Record<string, unknown>) => undefined,
    requestWillBeSent: (_listener: (event: unknown) => void) => () => undefined,
    responseReceived: (_listener: (event: unknown) => void) => () => undefined,
    loadingFinished: (_listener: (event: unknown) => void) => () => undefined,
    loadingFailed: (_listener: (event: unknown) => void) => () => undefined,
  };

  public async close(): Promise<void> {
    this.closeCalls += 1;
  }

  public on(_event: "disconnect", _listener: () => void): void {}

  private registerObject(id: string, value: FakeHTMLElement): void {
    this.objectsById.set(id, value);
    this.idsByObject.set(value, id);
  }
}

async function createExecutableSession(mode: ComposerMode, text: string) {
  const client = new ExecutableExistingSendCriClient(mode, text);
  const transport = new ChromeRemoteInterfaceTransport({ connect: async () => client as never });
  const session = (await transport.connect({ host: "127.0.0.1", port: 9223, target })) as CdpTurnTransportSession;
  await session.initializeReadinessObservation();
  assert.ok(session.clickExistingTurnSendButton);
  return { client, session };
}

async function expectRejected(
  session: CdpTurnTransportSession,
  text: string,
  backendDOMNodeId = 501,
): Promise<void> {
  await assert.rejects(
    () => session.clickExistingTurnSendButton!(locator, backendDOMNodeId, text),
    /existing-thread send control was unavailable|existing-thread composer operation failed/,
  );
}

async function rejectionCase(
  name: string,
  mode: ComposerMode,
  text: string,
  mutate: (client: ExecutableExistingSendCriClient) => void,
  backendDOMNodeId = 501,
): Promise<void> {
  test(name, async () => {
    const { client, session } = await createExecutableSession(mode, text);
    mutate(client);
    await expectRejected(session, text, backendDOMNodeId);
    assert.equal(client.totalClicks(), 0);
  });
}

test("existing-thread text-control Send validates exact route/composer/form/value, clicks once, and releases objects", async () => {
  const text = "THREAD_TEXT_EXACT";
  const { client, session } = await createExecutableSession("TEXT", text);
  const send = client.addEligibleSend();
  await session.clickExistingTurnSendButton!(locator, 501, text);
  assert.equal(send.clickCount, 1);
  assert.equal(client.callFunctionCalls.length, 3);
  assert.deepEqual(client.releaseObjectCalls, ["form-601", "composer-501"]);
});

test("existing-thread contenteditable Send accepts exact multiline AX projection and stable representation", async () => {
  const text = "THREAD_LINE_A\nTHREAD_LINE_B";
  const { client, session } = await createExecutableSession("CONTENTEDITABLE", text);
  const send = client.addEligibleSend();
  await session.clickExistingTurnSendButton!(locator, 501, text);
  assert.equal(send.clickCount, 1);
  assert.equal(client.callFunctionCalls.length, 3);
  assert.deepEqual(client.releaseObjectCalls, ["form-601", "composer-501"]);
});

await rejectionCase("existing-thread text-control Send rejects mismatched value", "TEXT", "EXPECTED_TEXT", (client) => {
  (client.composer as FakeHTMLTextAreaElement).value = "ACTUAL_TEXT";
  client.addEligibleSend();
});
await rejectionCase("existing-thread contenteditable Send rejects AX mismatch", "CONTENTEDITABLE", "THREAD_AX", (client) => {
  client.axNodes = [axComposer("DIFFERENT_AX_VALUE")];
  client.addEligibleSend();
});
await rejectionCase("existing-thread contenteditable Send rejects AX ambiguity", "CONTENTEDITABLE", "THREAD_AX", (client) => {
  client.axNodes = [axComposer("THREAD_AX"), axComposer("THREAD_AX")];
  client.addEligibleSend();
});
await rejectionCase("existing-thread contenteditable Send fails closed on malformed AX value", "CONTENTEDITABLE", "THREAD_AX", (client) => {
  client.axNodes = [axComposer({ unexpected: true })];
  client.addEligibleSend();
});
await rejectionCase("existing-thread Send TOCTOU rejects changed contenteditable representation", "CONTENTEDITABLE", "THREAD_HTML", (client) => {
  client.addEligibleSend();
  client.beforeRuntimeCall = (callNumber) => {
    if (callNumber === 3) client.composer.innerHTML = "<p>changed-after-ax</p>";
  };
});
await rejectionCase("existing-thread Send TOCTOU rejects changed form identity", "TEXT", "THREAD_FORM", (client) => {
  client.addEligibleSend();
  client.beforeRuntimeCall = (callNumber) => {
    if (callNumber === 3) client.composer.ownerForm = client.alternateForm;
  };
});
await rejectionCase("existing-thread Send TOCTOU rejects route drift", "TEXT", "THREAD_ROUTE", (client) => {
  client.addEligibleSend();
  client.beforeRuntimeCall = (callNumber) => {
    if (callNumber === 3) client.frame.url = OTHER_ROUTE;
  };
});
await rejectionCase("existing-thread Send TOCTOU rejects composer losing active focus", "TEXT", "THREAD_FOCUS", (client) => {
  client.addEligibleSend();
  client.beforeRuntimeCall = (callNumber) => {
    if (callNumber === 3) client.document.activeElement = client.wrongComposer;
  };
});
await rejectionCase("existing-thread Send rejects hidden composer", "TEXT", "THREAD_HIDDEN_COMPOSER", (client) => {
  client.composer.offsetParent = null;
  client.addEligibleSend();
});
await rejectionCase("existing-thread Send rejects composer that is no longer editable", "CONTENTEDITABLE", "THREAD_NOT_EDITABLE", (client) => {
  client.composer.setAttribute("contenteditable", "false");
  client.addEligibleSend();
});
await rejectionCase("existing-thread Send rejects zero eligible same-form Send controls", "TEXT", "THREAD_ZERO_SEND", () => undefined);
await rejectionCase("existing-thread Send rejects multiple eligible same-form Send controls", "TEXT", "THREAD_MULTI_SEND", (client) => {
  client.addEligibleSend();
  client.addEligibleSend();
});
await rejectionCase("existing-thread Send ignores Send outside composer form", "TEXT", "THREAD_OUTSIDE_SEND", (client) => {
  client.addEligibleSend(client.alternateForm);
});
await rejectionCase("existing-thread Send rejects hidden Send", "TEXT", "THREAD_HIDDEN_SEND", (client) => {
  client.addEligibleSend().offsetParent = null;
});
await rejectionCase("existing-thread Send rejects non-HTMLButtonElement candidate", "TEXT", "THREAD_NON_BUTTON", (client) => {
  client.addGenericSend();
});
await rejectionCase("existing-thread Send rejects button with different form identity", "TEXT", "THREAD_BUTTON_FORM", (client) => {
  const send = new FakeHTMLButtonElement(client.alternateForm);
  client.form.sendCandidates.push(send);
  client.buttons.push(send);
});
await rejectionCase("existing-thread Send rejects disabled button", "TEXT", "THREAD_DISABLED", (client) => {
  client.addEligibleSend().disabled = true;
});
await rejectionCase("existing-thread Send rejects aria-disabled button", "TEXT", "THREAD_ARIA_DISABLED", (client) => {
  client.addEligibleSend().setAttribute("aria-disabled", "true");
});
await rejectionCase("existing-thread Send rejects wrong conversation route", "TEXT", "THREAD_WRONG_ROUTE", (client) => {
  client.frame.url = OTHER_ROUTE;
  client.addEligibleSend();
});
await rejectionCase("existing-thread Send rejects wrong composer backend identity", "TEXT", "THREAD_WRONG_COMPOSER", (client) => {
  client.addEligibleSend();
}, 999);
await rejectionCase("existing-thread Send rejects unresolved composer object", "TEXT", "THREAD_UNRESOLVED_COMPOSER", (client) => {
  client.addEligibleSend();
}, 777);
await rejectionCase("existing-thread Send rejects unresolved form object", "TEXT", "THREAD_UNRESOLVED_FORM", (client) => {
  client.composer.ownerForm = null;
  client.addEligibleSend();
});

function assertSanitized(error: unknown, canaries: readonly string[]): boolean {
  assert.ok(error instanceof Error);
  const exposed = `${error.name}\n${error.message}\n${error.cause instanceof Error ? error.cause.message : ""}`;
  for (const canary of canaries) assert.equal(exposed.includes(canary), false);
  return true;
}

test("existing-thread Send sanitizes CRI, AX, and cleanup failures", async (t) => {
  const prompt = "PROMPT_CANARY_DO_NOT_EXPOSE";
  const rawProtocol = "ProtocolError RAW_PROTOCOL_CANARY requestId=REQUEST_CANARY objectId=composer-501";
  const canaries = [prompt, locator, "RAW_PROTOCOL_CANARY", "REQUEST_CANARY", "composer-501"];
  const run = async (
    mode: ComposerMode,
    setup: (client: ExecutableExistingSendCriClient) => void,
  ) => {
    const { client, session } = await createExecutableSession(mode, prompt);
    setup(client);
    await assert.rejects(
      () => session.clickExistingTurnSendButton!(locator, 501, prompt),
      (error: unknown) => assertSanitized(error, canaries),
    );
    return client;
  };

  await t.test("DOM.resolveNode", async () => {
    await run("TEXT", (client) => { client.resolveError = new Error(rawProtocol); });
  });
  await t.test("Runtime.callFunctionOn form", async () => {
    await run("TEXT", (client) => { client.runtimeErrors.set(1, new Error(rawProtocol)); });
  });
  await t.test("Runtime.callFunctionOn semantic validation", async () => {
    await run("TEXT", (client) => { client.runtimeErrors.set(2, new Error(rawProtocol)); });
  });
  await t.test("Accessibility.getFullAXTree", async () => {
    await run("CONTENTEDITABLE", (client) => { client.axError = new Error(rawProtocol); });
  });
  await t.test("Runtime.callFunctionOn final click", async () => {
    await run("TEXT", (client) => {
      client.addEligibleSend();
      client.runtimeErrors.set(3, new Error(rawProtocol));
    });
  });
  await t.test("Runtime.releaseObject", async () => {
    const client = await run("TEXT", (candidate) => {
      candidate.addEligibleSend();
      candidate.releaseError = new Error(rawProtocol);
    });
    assert.ok(client.closeCalls >= 1);
  });
});

const observationHandle = Object.freeze({}) as unknown as CdpTurnObservationHandle;

class Discovery implements CdpTargetDiscoveryLike {
  public async findPrimaryTarget(): Promise<CdpTargetInfo> {
    return target;
  }
}

class BaseManagerTurnSession implements CdpTurnTransportSession {
  public readonly existingSendCalls: Array<Readonly<{
    locator: ConversationLocator;
    backendDOMNodeId: number;
    expectedText: string;
    signal?: AbortSignal;
  }>> = [];
  public closeCalls = 0;
  private readonly disconnectListeners = new Set<() => void>();

  public async close(): Promise<void> { this.closeCalls += 1; }
  public onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }
  public async initializeReadinessObservation(): Promise<void> {}
  public async navigate(_url: string): Promise<void> {}
  public async reload(): Promise<void> {}
  public async getReadinessSnapshot(_expectedRoute: RouteExpectation): Promise<ExistingReadinessSnapshot> {
    return {
      mainFrame: { frameId: "main", loaderId: "loader", expectedRoute: true },
      eligibleEditables: [{ backendDOMNodeId: 501, focused: true }],
      backendActivity: { activeCount: 0, activityEpoch: 1 },
    };
  }
  public async focusBackendNode(_backendDOMNodeId: number): Promise<void> {}
  public async getTurnComposerState(_expectedRoute: RouteExpectation) {
    return Object.freeze({ expectedRoute: true, eligible: true, focused: true, empty: false, backendDOMNodeId: 501 });
  }
  public armTurnObservation(): CdpTurnObservationHandle { return observationHandle; }
  public getTurnObservation(_handle: CdpTurnObservationHandle) { return Object.freeze({ prepareCount: 0, write: null }); }
  public releaseTurnObservation(_handle: CdpTurnObservationHandle): void {}
  public async insertText(_text: string): Promise<void> {}
  public async dispatchEnterKeyDown(): Promise<void> {}
  public async dispatchEnterKeyUp(): Promise<void> {}
  public async getCurrentConversationLocator(): Promise<ConversationLocator> { return locator; }
  public emitDisconnect(): void {
    for (const listener of [...this.disconnectListeners]) listener();
  }
}

class ManagerTurnSession extends BaseManagerTurnSession {
  public async clickExistingTurnSendButton(
    conversationLocator: ConversationLocator,
    backendDOMNodeId: number,
    expectedText: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.existingSendCalls.push(Object.freeze({
      locator: conversationLocator,
      backendDOMNodeId,
      expectedText,
      ...(signal === undefined ? {} : { signal }),
    }));
  }
}

class BlockingManagerTurnSession extends ManagerTurnSession {
  public override async clickExistingTurnSendButton(
    conversationLocator: ConversationLocator,
    backendDOMNodeId: number,
    expectedText: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await super.clickExistingTurnSendButton(conversationLocator, backendDOMNodeId, expectedText, signal);
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new OperationAbortedError()), { once: true });
    });
  }
}

class ManagerTransport implements CdpTransport {
  public constructor(public readonly session: CdpTurnTransportSession) {}
  public async connect(_options: CdpTransportConnectOptions): Promise<CdpTurnTransportSession> { return this.session; }
}

function createRuntime(): RuntimeGenerationTracker {
  const runtime = new RuntimeGenerationTracker();
  runtime.observe({ pid: 100, creationTime: "runtime-a" });
  return runtime;
}

async function createManager(runtime: RuntimeGenerationTracker, session: CdpTurnTransportSession) {
  const manager = new CdpSessionManager(config, runtime, {
    discovery: new Discovery(),
    transport: new ManagerTransport(session),
    attachTimeoutMs: 100,
  });
  await manager.connect();
  return manager;
}

test("manager delegates existing-thread Send exactly once for current lease and preserves signal identity", async () => {
  const runtime = createRuntime();
  const session = new ManagerTurnSession();
  const manager = await createManager(runtime, session);
  const lease = runtime.getCurrentRuntimeLease();
  const controller = new AbortController();
  await manager.clickExistingTurnSendButton(locator, 501, "THREAD_MANAGER_TEXT", lease, controller.signal);
  assert.deepEqual(session.existingSendCalls, [{
    locator,
    backendDOMNodeId: 501,
    expectedText: "THREAD_MANAGER_TEXT",
    signal: controller.signal,
  }]);
});

test("manager rejects stale RuntimeLease before existing-thread Send mutation", async () => {
  const runtime = createRuntime();
  const staleLease = runtime.getCurrentRuntimeLease();
  runtime.observe({ pid: 200, creationTime: "runtime-b" });
  const session = new ManagerTurnSession();
  const manager = await createManager(runtime, session);
  await assert.rejects(
    () => manager.clickExistingTurnSendButton(locator, 501, "THREAD_STALE", staleLease),
    RuntimeGenerationChangedError,
  );
  assert.equal(session.existingSendCalls.length, 0);
});

test("manager blocks runtime replacement after capability check and before delegation", async () => {
  const runtime = createRuntime();
  const concrete = new ManagerTurnSession();
  let replaced = false;
  const proxied = new Proxy(concrete, {
    get(targetSession, property, receiver) {
      if (property === "clickExistingTurnSendButton" && !replaced) {
        replaced = true;
        runtime.observe({ pid: 200, creationTime: "runtime-b" });
      }
      return Reflect.get(targetSession, property, receiver);
    },
  });
  const manager = await createManager(runtime, proxied);
  const lease = runtime.getCurrentRuntimeLease();
  await assert.rejects(
    () => manager.clickExistingTurnSendButton(locator, 501, "THREAD_REPLACED", lease),
    RuntimeGenerationChangedError,
  );
  assert.equal(concrete.existingSendCalls.length, 0);
});

test("manager rejects existing-thread Send after current-session disconnect", async () => {
  const runtime = createRuntime();
  const session = new ManagerTurnSession();
  const manager = await createManager(runtime, session);
  const lease = runtime.getCurrentRuntimeLease();
  session.emitDisconnect();
  await assert.rejects(
    () => manager.clickExistingTurnSendButton(locator, 501, "THREAD_DISCONNECTED", lease),
    CdpDisconnectedError,
  );
  assert.equal(session.existingSendCalls.length, 0);
});

test("manager preserves pre-aborted existing-thread Send cancellation without delegation", async () => {
  const runtime = createRuntime();
  const session = new ManagerTurnSession();
  const manager = await createManager(runtime, session);
  const lease = runtime.getCurrentRuntimeLease();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => manager.clickExistingTurnSendButton(locator, 501, "THREAD_ABORTED", lease, controller.signal),
    OperationAbortedError,
  );
  assert.equal(session.existingSendCalls.length, 0);
});

test("manager preserves in-flight abort and invalidates the mutating session", async () => {
  const runtime = createRuntime();
  const session = new BlockingManagerTurnSession();
  const manager = await createManager(runtime, session);
  const lease = runtime.getCurrentRuntimeLease();
  const controller = new AbortController();
  const operation = manager.clickExistingTurnSendButton(locator, 501, "THREAD_INFLIGHT_ABORT", lease, controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(operation, OperationAbortedError);
  assert.equal(session.existingSendCalls.length, 1);
  assert.ok(session.closeCalls >= 1);
});

test("manager reports unsupported existing-thread Send capability with stable sanitized CDP error", async () => {
  const runtime = createRuntime();
  const session = new BaseManagerTurnSession();
  const manager = await createManager(runtime, session);
  const lease = runtime.getCurrentRuntimeLease();
  const prompt = "UNSUPPORTED_PROMPT_CANARY";
  await assert.rejects(
    () => manager.clickExistingTurnSendButton(locator, 501, prompt, lease),
    (error: unknown) => {
      assert.ok(error instanceof CdpDisconnectedError);
      assert.equal(error.code, "CDP_DISCONNECTED");
      assert.equal(error.message.includes(prompt), false);
      assert.equal(error.message.includes(locator), false);
      return true;
    },
  );
});
