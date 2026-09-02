import { AsyncLocalStorage } from "node:async_hooks";
import { ConversationLocator } from "../domain/ThreadIdentity.js";
import { ProjectLocator, ProjectName } from "../domain/ProjectIdentity.js";
import { RouteExpectation } from "../readiness/types.js";
import { CdpBeforeMutationHook } from "./CdpTransport.js";
import type { CriClient } from "./ChromeRemoteInterfaceTransport.js";
import { ChromeRemoteInterfaceSession } from "./ChromeRemoteInterfaceSession.js";

type MutationScope = Readonly<{
  signal?: AbortSignal;
  pageNavigate?: boolean;
  pageReload?: boolean;
  domFocus?: boolean;
  inputInsertText?: boolean;
  inputDispatchKeyEvent?: boolean;
  runtimeEvaluate?: boolean;
  runtimeCallFunctionOn?: boolean;
}>;

function shouldGuard(
  scope: MutationScope | undefined,
  domain: "Page" | "DOM" | "Input" | "Runtime",
  method: PropertyKey,
): boolean {
  if (scope === undefined) {
    return false;
  }
  if (domain === "Page") {
    return (method === "navigate" && scope.pageNavigate === true) ||
      (method === "reload" && scope.pageReload === true);
  }
  if (domain === "DOM") {
    return method === "focus" && scope.domFocus === true;
  }
  if (domain === "Input") {
    return (method === "insertText" && scope.inputInsertText === true) ||
      (method === "dispatchKeyEvent" && scope.inputDispatchKeyEvent === true);
  }
  return (method === "evaluate" && scope.runtimeEvaluate === true) ||
    (method === "callFunctionOn" && scope.runtimeCallFunctionOn === true);
}

function guardDomain<T extends object>(
  domain: T,
  domainName: "Page" | "DOM" | "Input" | "Runtime",
  storage: AsyncLocalStorage<MutationScope>,
  beforeMutation: CdpBeforeMutationHook,
): T {
  return new Proxy(domain, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      if (
        ![
          "navigate",
          "reload",
          "focus",
          "insertText",
          "dispatchKeyEvent",
          "evaluate",
          "callFunctionOn",
        ].includes(String(property))
      ) {
        return value.bind(target);
      }
      return async (...args: unknown[]) => {
        const scope = storage.getStore();
        if (shouldGuard(scope, domainName, property)) {
          await beforeMutation(scope?.signal);
        }
        return await Reflect.apply(value, target, args);
      };
    },
  });
}

function mutationAwareClient(
  client: CriClient,
  storage: AsyncLocalStorage<MutationScope>,
  beforeMutation: CdpBeforeMutationHook,
): CriClient {
  const page = guardDomain(client.Page, "Page", storage, beforeMutation);
  const dom = guardDomain(client.DOM, "DOM", storage, beforeMutation);
  const input = guardDomain(client.Input, "Input", storage, beforeMutation);
  const runtime = guardDomain(client.Runtime, "Runtime", storage, beforeMutation);

  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "Page") return page;
      if (property === "DOM") return dom;
      if (property === "Input") return input;
      if (property === "Runtime") return runtime;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export class MutationGuardedChromeRemoteInterfaceSession extends ChromeRemoteInterfaceSession {
  private readonly mutationScope: AsyncLocalStorage<MutationScope>;

  public constructor(client: CriClient, beforeMutation: CdpBeforeMutationHook) {
    const mutationScope = new AsyncLocalStorage<MutationScope>();
    super(mutationAwareClient(client, mutationScope, beforeMutation));
    this.mutationScope = mutationScope;
  }

  public override async navigate(url: string): Promise<void> {
    await this.withMutationScope({ pageNavigate: true }, () => super.navigate(url));
  }

  public override async reload(): Promise<void> {
    await this.withMutationScope({ pageReload: true }, () => super.reload());
  }

  public override async navigateAndWaitForLoadSettlement(
    url: string,
    expectedRoute: RouteExpectation,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.withMutationScope(
      { pageNavigate: true, ...(signal ? { signal } : {}) },
      () => super.navigateAndWaitForLoadSettlement(url, expectedRoute, signal),
    );
  }

  public override async focusBackendNode(backendDOMNodeId: number): Promise<void> {
    await this.withMutationScope(
      { domFocus: true },
      () => super.focusBackendNode(backendDOMNodeId),
    );
  }

  public override async insertText(text: string): Promise<void> {
    await this.withMutationScope(
      { inputInsertText: true },
      () => super.insertText(text),
    );
  }

  public override async insertTextIntoProjectComposer(
    text: string,
    projectLocator: ProjectLocator,
    backendDOMNodeId: number,
    signal?: AbortSignal,
  ): Promise<number> {
    return await this.withMutationScope(
      { inputInsertText: true, ...(signal ? { signal } : {}) },
      () => super.insertTextIntoProjectComposer(text, projectLocator, backendDOMNodeId, signal),
    );
  }

  public override async dispatchEnterKeyDown(): Promise<void> {
    await this.withMutationScope(
      { inputDispatchKeyEvent: true },
      () => super.dispatchEnterKeyDown(),
    );
  }

  public override async dispatchEnterKeyUp(): Promise<void> {
    await this.withMutationScope(
      { inputDispatchKeyEvent: true },
      () => super.dispatchEnterKeyUp(),
    );
  }

  public override async clickTurnSendButton(
    projectLocator: ProjectLocator,
    backendDOMNodeId: number,
    formBackendDOMNodeId: number,
    expectedText: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.withMutationScope(
      { runtimeCallFunctionOn: true, ...(signal ? { signal } : {}) },
      () => super.clickTurnSendButton(
        projectLocator,
        backendDOMNodeId,
        formBackendDOMNodeId,
        expectedText,
        signal,
      ),
    );
  }

  public override async clickExistingTurnSendButton(
    conversationLocator: ConversationLocator,
    backendDOMNodeId: number,
    expectedText: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.withMutationScope(
      { runtimeCallFunctionOn: true, ...(signal ? { signal } : {}) },
      () => super.clickExistingTurnSendButton(
        conversationLocator,
        backendDOMNodeId,
        expectedText,
        signal,
      ),
    );
  }

  public override async createProjectThroughUi(
    name: ProjectName,
    signal?: AbortSignal,
    onMutationAttempted?: () => void,
  ): Promise<ProjectLocator> {
    return await this.withMutationScope(
      {
        runtimeEvaluate: true,
        inputInsertText: true,
        ...(signal ? { signal } : {}),
      },
      () => super.createProjectThroughUi(name, signal, onMutationAttempted),
    );
  }

  private async withMutationScope<T>(
    scope: MutationScope,
    operation: () => Promise<T>,
  ): Promise<T> {
    return await this.mutationScope.run(scope, operation);
  }
}
