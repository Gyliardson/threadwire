import assert from "node:assert/strict";
import test from "node:test";
import { ChromeRemoteInterfaceTransport } from "../../src/cdp/ChromeRemoteInterfaceTransport.js";
import { CdpTurnTransportSession } from "../../src/cdp/CdpTransport.js";
import { CdpTargetInfo } from "../../src/cdp/types.js";
import { createConversationLocator } from "../../src/domain/ThreadIdentity.js";
import { createProjectLocator } from "../../src/domain/ProjectIdentity.js";
import { RouteExpectation } from "../../src/readiness/types.js";

const target: CdpTargetInfo = {
  id: "target-turn",
  title: "ChatGPT",
  type: "page",
  description: "",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/target-turn",
  url: "https://chatgpt.com/c/synthetic-turn",
};
const expectedRoute: RouteExpectation = {
  kind: "THREAD",
  locator: createConversationLocator("https://chatgpt.com/c/synthetic-turn"),
};

type RequestPayload = {
  url: string;
  method: string;
  headers: Record<string, string> | undefined;
  postData: string | undefined;
};
type RequestListener = (event: {
  requestId: string;
  request: RequestPayload;
}) => void;
type ResponsePayload = {
  status: number;
  headers?: Record<string, string>;
};
type ResponseListener = (event: {
  requestId: string;
  response: ResponsePayload;
}) => void;
type SettledListener = (event: { requestId: string }) => void;

function eligibleComposerNode(value: unknown, valuePresent: boolean): Record<string, unknown> {
  const node: Record<string, unknown> = {
    ignored: false,
    role: { value: "textbox" },
    name: { value: "ACCESSIBLE_NAME_SECRET" },
    backendDOMNodeId: 501,
    properties: [
      { name: "multiline", value: { value: true } },
      { name: "focusable", value: { value: true } },
      { name: "editable", value: { value: "richtext" } },
      { name: "focused", value: { value: true } },
    ],
  };
  if (valuePresent) {
    node.value = value;
  }
  return node;
}

class FakeTurnCriClient {
  public frame = {
    id: "main",
    loaderId: "loader-turn",
    url: "https://chatgpt.com/c/synthetic-turn",
  };
  public axNodes: readonly unknown[] = [eligibleComposerNode({ value: "" }, true)];
  public readonly inputCalls: Array<Readonly<Record<string, unknown>>> = [];
  public readonly focusCalls: number[] = [];
  public readonly evaluateCalls: string[] = [];
  public readonly evaluateResults: unknown[] = [];
  public readonly callFunctionCalls: Array<Readonly<Record<string, unknown>>> = [];
  public readonly callFunctionResults: unknown[] = [];
  public readonly releaseObjectCalls: string[] = [];
  public releaseObjectError: Error | null = null;
  private readonly disconnectListeners = new Set<() => void>();
  private readonly requestListeners = new Set<RequestListener>();
  private readonly responseListeners = new Set<ResponseListener>();
  private readonly finishedListeners = new Set<SettledListener>();
  private readonly failedListeners = new Set<SettledListener>();

  public readonly Page = {
    navigate: async (_params: { url: string }) => ({}),
    reload: async (_params: { ignoreCache?: boolean } = {}) => undefined,
    getFrameTree: async () => ({ frameTree: { frame: this.frame } }),
  };

  public readonly Accessibility = {
    getFullAXTree: async (_params: { frameId: string }) => ({ nodes: this.axNodes }),
  };

  public readonly DOM = {
    focus: async ({ backendNodeId }: { backendNodeId: number }) => {
      this.focusCalls.push(backendNodeId);
    },
    resolveNode: async ({ backendNodeId }: { backendNodeId: number }) => ({
      object: { objectId: backendNodeId === 501 ? "composer-501" : `form-${backendNodeId}` },
    }),
    describeNode: async ({ objectId }: { objectId: string }) => ({
      node: { backendNodeId: Number(objectId.replace("form-", "")) },
    }),
  };

  public readonly Input = {
    insertText: async (params: { text: string }) => {
      this.inputCalls.push(Object.freeze({ method: "insertText", ...params }));
    },
    dispatchKeyEvent: async (params: Record<string, unknown>) => {
      this.inputCalls.push(Object.freeze({ method: "dispatchKeyEvent", ...params }));
    },
  };

  public readonly Runtime = {
    evaluate: async ({ expression }: { expression: string; returnByValue?: boolean }) => {
      this.evaluateCalls.push(expression);
      const value = this.evaluateResults.shift();
      return { result: { value } };
    },
    callFunctionOn: async (params: Record<string, unknown>) => {
      this.callFunctionCalls.push(params);
      const result = this.callFunctionResults.shift();
      if (typeof result === "object" && result !== null && "objectId" in result) {
        return { result };
      }
      return { result: { value: result } };
    },
    releaseObject: async ({ objectId }: { objectId: string }) => {
      this.releaseObjectCalls.push(objectId);
      if (this.releaseObjectError !== null) throw this.releaseObjectError;
    },
  };

  public readonly Network = {
    enable: async (_options: Record<string, unknown>) => undefined,
    requestWillBeSent: (listener: RequestListener) => {
      this.requestListeners.add(listener);
      return () => this.requestListeners.delete(listener);
    },
    responseReceived: (listener: ResponseListener) => {
      this.responseListeners.add(listener);
      return () => this.responseListeners.delete(listener);
    },
    loadingFinished: (listener: SettledListener) => {
      this.finishedListeners.add(listener);
      return () => this.finishedListeners.delete(listener);
    },
    loadingFailed: (listener: SettledListener) => {
      this.failedListeners.add(listener);
      return () => this.failedListeners.delete(listener);
    },
  };

  public async close(): Promise<void> {}

  public on(event: "disconnect", listener: () => void): void {
    if (event === "disconnect") {
      this.disconnectListeners.add(listener);
    }
  }

  public emitRequest(
    requestId: string,
    url: string,
    method = "GET",
    extra: Readonly<Record<string, unknown>> = {},
  ): void {
    for (const listener of this.requestListeners) {
      listener({
        requestId,
        request: {
          url,
          method,
          headers: extra.headers as Record<string, string> | undefined,
          postData: extra.postData as string | undefined,
        },
      });
    }
  }

  public emitResponse(requestId: string, status: number): void {
    for (const listener of this.responseListeners) {
      listener({ requestId, response: { status } });
    }
  }

  public emitGuardedWrite(requestId: string): void {
    const request: Record<string, unknown> = {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
    };
    Object.defineProperty(request, "headers", {
      get: () => {
        throw new Error("request headers must not be read");
      },
    });
    Object.defineProperty(request, "postData", {
      get: () => {
        throw new Error("request postData must not be read");
      },
    });
    for (const listener of this.requestListeners) {
      listener({ requestId, request: request as RequestPayload });
    }
  }

  public emitGuardedResponse(requestId: string, status: number): void {
    const response: Record<string, unknown> = { status };
    Object.defineProperty(response, "headers", {
      get: () => {
        throw new Error("response headers must not be read");
      },
    });
    for (const listener of this.responseListeners) {
      listener({ requestId, response: response as ResponsePayload });
    }
  }

  public emitFinished(requestId: string): void {
    for (const listener of this.finishedListeners) {
      listener({ requestId });
    }
  }

  public emitFailed(requestId: string): void {
    for (const listener of this.failedListeners) {
      listener({ requestId });
    }
  }
}

async function createSession(client = new FakeTurnCriClient()): Promise<{
  client: FakeTurnCriClient;
  session: CdpTurnTransportSession;
}> {
  const transport = new ChromeRemoteInterfaceTransport({ connect: async () => client });
  const session = (await transport.connect({
    host: "127.0.0.1",
    port: 9223,
    target,
  })) as CdpTurnTransportSession;
  await session.initializeReadinessObservation();
  return { client, session };
}

test("turn composer state exposes route/eligible/focused/empty booleans only", async () => {
  const { client, session } = await createSession();
  const empty = await session.getTurnComposerState(expectedRoute);
  assert.deepEqual(empty, {
    expectedRoute: true,
    eligible: true,
    focused: true,
    empty: true,
    backendDOMNodeId: 501,
  });
  assert.equal(JSON.stringify(empty).includes("ACCESSIBLE_NAME_SECRET"), false);

  client.axNodes = [eligibleComposerNode({ value: "ACCESSIBLE_VALUE_SECRET" }, true)];
  const nonEmpty = await session.getTurnComposerState(expectedRoute);
  assert.deepEqual(nonEmpty, {
    expectedRoute: true,
    eligible: true,
    focused: true,
    empty: false,
    backendDOMNodeId: 501,
  });
  assert.equal(JSON.stringify(nonEmpty).includes("ACCESSIBLE_VALUE_SECRET"), false);

  client.frame.url = "https://chatgpt.com/c/synthetic-other";
  const drifted = await session.getTurnComposerState(expectedRoute);
  assert.equal(drifted.expectedRoute, false);
  assert.equal(JSON.stringify(drifted).includes("synthetic-other"), false);
});

test("real Classic empty composer shape with absent AXNode.value is known empty", async () => {
  const { client, session } = await createSession();
  client.axNodes = [eligibleComposerNode(undefined, false)];

  assert.deepEqual(await session.getTurnComposerState(expectedRoute), {
    expectedRoute: true,
    eligible: true,
    focused: true,
    empty: true,
    backendDOMNodeId: 501,
  });
});

test("explicit empty-string AX value remains known empty", async () => {
  const { client, session } = await createSession();
  client.axNodes = [eligibleComposerNode({ value: "" }, true)];

  assert.equal((await session.getTurnComposerState(expectedRoute)).empty, true);
});

test("present nonempty AX string remains nonempty without exposing content", async () => {
  const { client, session } = await createSession();
  const canary = "synthetic nonempty canary";
  client.axNodes = [eligibleComposerNode({ value: canary }, true)];

  const state = await session.getTurnComposerState(expectedRoute);
  assert.equal(state.empty, false);
  assert.equal(JSON.stringify(state).includes(canary), false);
});

test("present AX value with unknown shape is not proven empty", async () => {
  const { client, session } = await createSession();
  client.axNodes = [eligibleComposerNode({}, true)];

  assert.equal((await session.getTurnComposerState(expectedRoute)).empty, false);
});

test("typed Input primitives preserve insertText then Enter keyDown/keyUp ordering", async () => {
  const { client, session } = await createSession();
  await session.insertText("PROMPT_TEXT_SECRET");
  await session.dispatchEnterKeyDown();
  await session.dispatchEnterKeyUp();

  assert.deepEqual(client.inputCalls, [
    { method: "insertText", text: "PROMPT_TEXT_SECRET" },
    {
      method: "dispatchKeyEvent",
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    },
    {
      method: "dispatchKeyEvent",
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    },
  ]);
  assert.equal("send" in session, false);
  assert.equal("reload" in session, true);
  assert.equal("evaluate" in session, false);
  assert.equal("getResponseBody" in session, false);
  assert.equal("streamResourceContent" in session, false);
});

test("Project input preserves multiline text through CDP insertText before exact Send validation", async () => {
  const { client, session } = await createSession();
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000002/project");
  const projectPrompt = "PROJECT_PROMPT_LINE_A\nPROJECT_PROMPT_LINE_B";
  client.frame.url = projectLocator;
  client.callFunctionResults.push({ objectId: "form-601" }, true, true, true);

  assert.equal(
    (await session.getTurnComposerState({ kind: "PROJECT_ROOT", locator: projectLocator }))
      .expectedRoute,
    true,
  );
  assert.ok(session.clickTurnSendButton);
  assert.ok(session.insertTextIntoProjectComposer);
  const formBackendDOMNodeId = await session.insertTextIntoProjectComposer(
    projectPrompt,
    projectLocator,
    501,
  );
  await session.clickTurnSendButton(
    projectLocator,
    501,
    formBackendDOMNodeId,
    projectPrompt,
  );

  assert.equal(formBackendDOMNodeId, 601);
  assert.deepEqual(client.focusCalls, []);
  assert.deepEqual(client.inputCalls, [{ method: "insertText", text: projectPrompt }]);
  assert.equal(client.callFunctionCalls.length, 4);
  const preflightCall = client.callFunctionCalls[0]!;
  const preInputCall = client.callFunctionCalls[1]!;
  const postInputCall = client.callFunctionCalls[2]!;
  const clickCall = client.callFunctionCalls[3]!;
  assert.equal(String(preflightCall.functionDeclaration).includes(projectPrompt), false);
  assert.equal(JSON.stringify(preflightCall.arguments).includes(projectPrompt), true);
  assert.equal(
    String(preflightCall.functionDeclaration).includes('button[data-testid="send-button"]'),
    false,
  );
  assert.equal(String(preflightCall.functionDeclaration).includes("setter.call"), false);
  assert.equal(String(preflightCall.functionDeclaration).includes("this.textContent = text"), false);
  assert.equal(String(preflightCall.functionDeclaration).includes("InputEvent"), false);
  assert.match(String(preInputCall.functionDeclaration), /this !== document\.activeElement/);
  assert.match(String(preInputCall.functionDeclaration), /this\.closest\('form'\) !== expectedForm/);
  assert.match(String(postInputCall.functionDeclaration), /inserted === text/);
  assert.equal(clickCall.objectId, "composer-501");
  assert.match(String(clickCall.functionDeclaration), /this !== document\.activeElement/);
  assert.match(String(clickCall.functionDeclaration), /button\[data-testid="send-button"\]/);
  assert.match(String(clickCall.functionDeclaration), /matches\.length !== 1/);
  assert.match(String(clickCall.functionDeclaration), /this\.closest\('form'\) !== expectedForm/);
  assert.match(String(clickCall.functionDeclaration), /button\.form === expectedForm/);
  assert.match(String(clickCall.functionDeclaration), /button\.disabled/);
  assert.match(String(clickCall.functionDeclaration), /inserted !== text/);
  assert.equal(JSON.stringify(clickCall).includes(projectLocator), true);
  assert.deepEqual(client.releaseObjectCalls, [
    "form-601",
    "composer-501",
    "form-601",
    "composer-501",
  ]);
});

test("Project pre-insert rejection occurs before any CDP prompt insertion", async () => {
  const { client, session } = await createSession();
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000002/project");
  client.callFunctionResults.push(false);

  await assert.rejects(
    () => session.insertTextIntoProjectComposer!("PROJECT_PROMPT_SECRET", projectLocator, 501),
    /expected Project composer was unavailable for input/,
  );
  assert.deepEqual(client.inputCalls, []);
  assert.equal(client.callFunctionCalls.length, 1);
  const declaration = String(client.callFunctionCalls[0]!.functionDeclaration);
  assert.ok(declaration.indexOf("location.origin") < declaration.indexOf("const form = this.closest('form')"));
  assert.ok(
    declaration.indexOf("const form = this.closest('form')") < declaration.indexOf("typeof text !== 'string'"),
  );
  assert.equal(declaration.includes("setter.call"), false);
  assert.equal(declaration.includes("this.textContent = text"), false);
  assert.equal(declaration.includes("InputEvent"), false);
  assert.equal(declaration.includes('button[data-testid="send-button"]'), false);
});

test("Project input revalidates the same focused form before CDP insertion", async () => {
  const { client, session } = await createSession();
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000002/project");
  client.frame.url = projectLocator;
  client.callFunctionResults.push({ objectId: "form-601" }, false);

  await assert.rejects(
    () => session.insertTextIntoProjectComposer!("PROJECT_PROMPT_SECRET", projectLocator, 501),
    /expected Project composer was unavailable for input/,
  );

  assert.deepEqual(client.inputCalls, []);
  assert.equal(client.callFunctionCalls.length, 2);
  const revalidation = String(client.callFunctionCalls[1]!.functionDeclaration);
  assert.match(revalidation, /this !== document\.activeElement/);
  assert.match(revalidation, /this\.closest\('form'\) !== expectedForm/);
  assert.match(revalidation, /content\.length === 0/);
  assert.deepEqual(client.releaseObjectCalls, ["form-601", "composer-501"]);
});

test("Project post-input exact-text mismatch fails closed after exactly one CDP insertion", async () => {
  const { client, session } = await createSession();
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000002/project");
  const projectPrompt = "PROJECT_PROMPT_LINE_A\nPROJECT_PROMPT_LINE_B";
  client.frame.url = projectLocator;
  client.callFunctionResults.push({ objectId: "form-601" }, true, false);

  await assert.rejects(
    () => session.insertTextIntoProjectComposer!(projectPrompt, projectLocator, 501),
    /expected Project composer was unavailable for input/,
  );

  assert.deepEqual(client.inputCalls, [{ method: "insertText", text: projectPrompt }]);
  assert.equal(client.callFunctionCalls.length, 3);
  assert.match(String(client.callFunctionCalls[2]!.functionDeclaration), /inserted === text/);
  assert.equal(
    String(client.callFunctionCalls[2]!.functionDeclaration).includes('button[data-testid="send-button"]'),
    false,
  );
  assert.deepEqual(client.releaseObjectCalls, ["form-601", "composer-501"]);
});

test("Project input may materialize Send after text while post-insert submission remains fail-closed", async () => {
  const { client, session } = await createSession();
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000002/project");
  client.frame.url = projectLocator;
  client.callFunctionResults.push({ objectId: "form-601" }, true, true, false);

  const formBackendDOMNodeId = await session.insertTextIntoProjectComposer!(
    "PROJECT_PROMPT_SECRET",
    projectLocator,
    501,
  );
  assert.equal(formBackendDOMNodeId, 601);
  await assert.rejects(
    () =>
      session.clickTurnSendButton!(
        projectLocator,
        501,
        formBackendDOMNodeId,
        "PROJECT_PROMPT_SECRET",
      ),
    /unique enabled turn send control was unavailable/,
  );

  assert.deepEqual(client.inputCalls, [{ method: "insertText", text: "PROJECT_PROMPT_SECRET" }]);
  const preflightDeclaration = String(client.callFunctionCalls[0]!.functionDeclaration);
  const postInputDeclaration = String(client.callFunctionCalls[2]!.functionDeclaration);
  const sendDeclaration = String(client.callFunctionCalls[3]!.functionDeclaration);
  assert.equal(preflightDeclaration.includes('button[data-testid="send-button"]'), false);
  assert.equal(postInputDeclaration.includes('button[data-testid="send-button"]'), false);
  assert.equal(sendDeclaration.includes('button[data-testid="send-button"]'), true);
  assert.match(sendDeclaration, /matches\.length !== 1/);
});

test("Project send control refuses route or composer mismatch without reporting success", async () => {
  const { client, session } = await createSession();
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000002/project");
  client.callFunctionResults.push(false);

  await assert.rejects(
    () => session.clickTurnSendButton!(projectLocator, 501, 601, "PROJECT_PROMPT_SECRET"),
    /unique enabled turn send control was unavailable/,
  );
  const declaration = String(client.callFunctionCalls[0]!.functionDeclaration);
  assert.ok(declaration.indexOf("location.origin") < declaration.indexOf("matches[0].click"));
  assert.ok(
    declaration.indexOf("this.closest('form') !== expectedForm") <
      declaration.indexOf("matches[0].click"),
  );
  assert.ok(declaration.indexOf("matches.length !== 1") < declaration.indexOf("matches[0].click"));
});

test("Project composer object cleanup failure is sanitized", async () => {
  const { client, session } = await createSession();
  const projectLocator = createProjectLocator("https://chatgpt.com/g/g-p-00000000000000000000000000000002/project");
  client.callFunctionResults.push({ objectId: "form-601" });
  client.releaseObjectError = new Error("REMOTE_OBJECT_SECRET");

  await assert.rejects(
    () => session.insertTextIntoProjectComposer!("PROJECT_PROMPT_SECRET", projectLocator, 501),
    (error: unknown) =>
      error instanceof Error &&
      !error.message.includes("REMOTE_OBJECT_SECRET") &&
      !error.message.includes("PROJECT_PROMPT_SECRET"),
  );
});

test("selected write needs 2xx response metadata plus loadingFinished for success", async () => {
  const { client, session } = await createSession();
  const handle = session.armTurnObservation();
  client.emitRequest("write-a", "https://chatgpt.com/backend-api/f/conversation", "POST");
  client.emitResponse("write-a", 200);
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "ACTIVE");
  client.emitFinished("write-a");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "FINISHED");
});

test("non-2xx or missing selected response metadata cannot produce false success", async () => {
  const { client, session } = await createSession();

  const nonSuccess = session.armTurnObservation();
  client.emitRequest("write-non-2xx", "https://chatgpt.com/backend-api/f/conversation", "POST");
  client.emitResponse("write-non-2xx", 500);
  assert.equal(session.getTurnObservation(nonSuccess).write?.lifecycle, "ACTIVE");
  client.emitFinished("write-non-2xx");
  assert.equal(session.getTurnObservation(nonSuccess).write?.lifecycle, "FAILED");
  session.releaseTurnObservation(nonSuccess);

  const missingStatus = session.armTurnObservation();
  client.emitRequest("write-no-status", "https://chatgpt.com/backend-api/f/conversation", "POST");
  client.emitFinished("write-no-status");
  assert.equal(session.getTurnObservation(missingStatus).write?.lifecycle, "FAILED");
});

test("loadingFailed is terminal failure regardless of response metadata", async () => {
  const { client, session } = await createSession();
  const handle = session.armTurnObservation();
  client.emitRequest("write-failed", "https://chatgpt.com/backend-api/f/conversation", "POST");
  client.emitResponse("write-failed", 204);
  client.emitFailed("write-failed");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "FAILED");
});

test("unrelated response and settlement events cannot terminalize the selected write", async () => {
  const { client, session } = await createSession();
  const handle = session.armTurnObservation();
  client.emitRequest("write-a", "https://chatgpt.com/backend-api/f/conversation", "POST");
  client.emitResponse("unrelated-b", 200);
  client.emitFinished("unrelated-b");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "ACTIVE");
  client.emitFailed("unrelated-c");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "ACTIVE");
  client.emitResponse("write-a", 200);
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "ACTIVE");
  client.emitFinished("write-a");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "FINISHED");
});

test("turn observer tracks prepare separately and does not copy protected request or response metadata", async () => {
  const { client, session } = await createSession();
  const handle = session.armTurnObservation();

  client.emitRequest(
    "ignored-request-id-secret",
    "https://chatgpt.com/backend-api/models?QUERY_SECRET=1",
    "GET",
    { headers: { authorization: "AUTH_SECRET" }, postData: "BODY_SECRET" },
  );
  client.emitRequest(
    "prepare-request-id-secret-1",
    "https://chatgpt.com/backend-api/f/conversation/prepare?QUERY_SECRET=1",
    "POST",
    { headers: { authorization: "AUTH_SECRET" }, postData: "BODY_SECRET" },
  );
  client.emitRequest(
    "prepare-request-id-secret-2",
    "https://chatgpt.com/backend-api/f/conversation/prepare",
    "POST",
  );
  client.emitRequest(
    "write-request-id-secret",
    "https://chatgpt.com/backend-api/f/conversation?QUERY_SECRET=1",
    "POST",
    { headers: { authorization: "AUTH_SECRET" }, postData: "BODY_SECRET" },
  );
  client.emitResponse("write-request-id-secret", 200);

  const active = session.getTurnObservation(handle);
  assert.equal(active.prepareCount, 2);
  assert.equal(active.write?.lifecycle, "ACTIVE");
  const serialized = JSON.stringify(active);
  for (const canary of [
    "QUERY_SECRET",
    "AUTH_SECRET",
    "BODY_SECRET",
    "write-request-id-secret",
    "prepare-request-id-secret",
  ]) {
    assert.equal(serialized.includes(canary), false);
  }

  client.emitFinished("write-request-id-secret");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "FINISHED");
});

test("protected metadata accessors are never dereferenced by M5 observation", async () => {
  const { client, session } = await createSession();
  const handle = session.armTurnObservation();
  client.emitGuardedWrite("guarded-write");
  client.emitGuardedResponse("guarded-write", 200);
  client.emitFinished("guarded-write");
  assert.equal(session.getTurnObservation(handle).write?.lifecycle, "FINISHED");
});

test("current conversation route is parsed internally and query metadata is discarded", async () => {
  const { client, session } = await createSession();
  client.frame.url = "https://chatgpt.com/c/synthetic-route?ROUTE_QUERY_SECRET=1#fragment";
  const locator = await session.getCurrentConversationLocator();
  assert.equal(locator, "https://chatgpt.com/c/synthetic-route");
  assert.equal(locator?.includes("ROUTE_QUERY_SECRET"), false);

  client.frame.url = "https://chatgpt.com/";
  assert.equal(await session.getCurrentConversationLocator(), null);
});
