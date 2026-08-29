import { ConversationLocator, createConversationLocator } from "../domain/ThreadIdentity.js";
import {
  ProjectLocator,
  ProjectName,
  createProjectLocator,
} from "../domain/ProjectIdentity.js";
import { ExistingReadinessSnapshot, RouteExpectation } from "../readiness/types.js";
import { NormalizedResponseStreamEvent } from "../response/types.js";
import {
  CdpFinalRenderedAssistantSnapshot,
  CdpNavigationSettlementTransportSession,
  CdpProjectUiTransportSession,
  CdpResponseRenderBaseline,
  CdpResponseTurnTransportSession,
  CdpTurnComposerState,
  CdpTurnObservationHandle,
  CdpTurnObservationOptions,
  CdpTurnObservationSnapshot,
} from "./CdpTransport.js";
import { delay, throwIfAborted } from "../utils/timeout.js";
import {
  CriClient,
  EligibleComposerTarget,
  ExperimentalNetworkDomain,
  isRelevantBackendUrl,
  routeMatchesExpected,
  toEligibleComposer,
  toReadinessEditable,
} from "./ChromeRemoteInterfaceHelpers.js";
import { CdpTurnObservationTracker } from "./CdpTurnObservationTracker.js";

const MAX_FINAL_RENDERED_TEXT_CHARS = 1_048_576;
const RENDERED_MESSAGE_SELECTOR =
  '[data-message-author-role="user"],[data-message-author-role="assistant"]';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export class ChromeRemoteInterfaceSession
  implements CdpResponseTurnTransportSession, CdpNavigationSettlementTransportSession, CdpProjectUiTransportSession
{
  private readonly activeRelevantRequestIds = new Set<string>();
  private readonly disconnectListeners = new Set<() => void>();
  private activityEpoch = 0;
  private readinessInitialized = false;
  private readinessUnsubscribers: Array<() => unknown> = [];
  private readonly turnObservation: CdpTurnObservationTracker;
  private responseDataObservationAvailable = false;
  private closed = false;

  public constructor(private readonly client: CriClient) {
    this.turnObservation = new CdpTurnObservationTracker(
      this.client.Network as unknown as ExperimentalNetworkDomain,
      () => this.responseDataObservationAvailable,
    );
    this.client.on("disconnect", this.handleDisconnect);
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.disconnectListeners.clear();
    this.disposeReadinessObservation();
    await this.client.close();
  }

  public onDisconnect(listener: () => void): () => void {
    if (this.closed) {
      queueMicrotask(listener);
      return () => undefined;
    }

    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  public async initializeReadinessObservation(): Promise<void> {
    if (this.readinessInitialized) {
      return;
    }
    if (this.closed) {
      throw new Error("CDP session is closed.");
    }

    const unsubscribers: Array<() => unknown> = [
      this.client.Network.requestWillBeSent((event) =>
        this.onRequestWillBeSent(
          event.requestId,
          event.request.url,
          event.request.method,
          event.redirectResponse !== undefined,
        ),
      ),
      this.client.Network.responseReceived((event) =>
        this.onResponseReceived(event.requestId, event.response.status),
      ),
      this.client.Network.loadingFinished((event) => this.onRequestSettled(event.requestId, false)),
      this.client.Network.loadingFailed((event) => this.onRequestSettled(event.requestId, true)),
    ];

    const responseNetwork = this.client.Network as unknown as ExperimentalNetworkDomain;
    if (typeof responseNetwork.dataReceived === "function") {
      unsubscribers.push(responseNetwork.dataReceived((event) => this.onDataReceived(event)));
      this.responseDataObservationAvailable = true;
    }
    this.readinessUnsubscribers = unsubscribers;

    try {
      await this.client.Network.enable({});
      this.readinessInitialized = true;
    } catch (error) {
      this.disposeReadinessObservation();
      throw error;
    }
  }

  public async navigate(url: string): Promise<void> {
    if (this.closed) {
      throw new Error("CDP session is closed.");
    }

    let result: Awaited<ReturnType<CriClient["Page"]["navigate"]>>;
    try {
      result = await this.client.Page.navigate({ url });
    } catch {
      throw new Error("CDP Page.navigate command failed without retained protocol metadata.");
    }
    if (typeof result.errorText === "string" && result.errorText.length > 0) {
      throw new Error("CDP Page.navigate reported a navigation error.");
    }
  }

  public async reload(): Promise<void> {
    if (this.closed) {
      throw new Error("CDP session is closed.");
    }
    try {
      await this.client.Page.reload({ ignoreCache: false });
    } catch {
      throw new Error("CDP Page.reload command failed without retained protocol metadata.");
    }
  }

  public async navigateAndWaitForLoadSettlement(
    url: string,
    expectedRoute: RouteExpectation,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.closed) {
      throw new Error("CDP session is closed.");
    }
    throwIfAborted(signal);

    const page = this.client.Page as unknown as {
      enable?: (params?: Record<string, unknown>) => Promise<unknown>;
      loadEventFired?: (listener: () => void) => (() => unknown) | unknown;
      frameStoppedLoading?: (listener: (event: { frameId?: string }) => void) => (() => unknown) | unknown;
      navigate?: (params: { url: string }) => Promise<{ frameId?: string; loaderId?: string; errorText?: string }>;
      getFrameTree?: () => Promise<{ frameTree: { frame: { id: string; loaderId?: string; url: string } } }>;
    };

    if (
      typeof page.enable !== "function" ||
      typeof page.loadEventFired !== "function" ||
      typeof page.frameStoppedLoading !== "function" ||
      typeof page.navigate !== "function" ||
      typeof page.getFrameTree !== "function"
    ) {
      throw new Error("CDP Page lifecycle observation is unavailable.");
    }

    let navigationInitiated = false;
    let loadEventFired = false;
    let matchingFrameStopped = false;
    let targetFrameId: string | null = null;
    const stoppedFrameIds = new Set<string>();

    let settlementResolver: (() => void) | null = null;
    const settlementPromise = new Promise<void>((resolve) => {
      settlementResolver = resolve;
    });

    const checkSettlement = (): void => {
      if (loadEventFired && matchingFrameStopped) {
        settlementResolver?.();
      }
    };

    const unsubscribers: Array<() => void> = [];

    const unsubLoad = page.loadEventFired(() => {
      if (!navigationInitiated) {
        return;
      }
      loadEventFired = true;
      checkSettlement();
    });
    if (typeof unsubLoad === "function") {
      unsubscribers.push(() => {
        (unsubLoad as () => unknown)();
      });
    }

    const unsubFrameStopped = page.frameStoppedLoading((event) => {
      if (!navigationInitiated) {
        return;
      }
      if (typeof event?.frameId === "string") {
        if (targetFrameId !== null) {
          if (event.frameId === targetFrameId) {
            matchingFrameStopped = true;
            checkSettlement();
          }
        } else {
          stoppedFrameIds.add(event.frameId);
        }
      }
    });
    if (typeof unsubFrameStopped === "function") {
      unsubscribers.push(() => {
        (unsubFrameStopped as () => unknown)();
      });
    }

    try {
      try {
        await page.enable({});
      } catch {
        throw new Error("CDP Page.enable failed without retained protocol metadata.");
      }

      throwIfAborted(signal);

      navigationInitiated = true;
      let navResult: { frameId?: string; loaderId?: string; errorText?: string };
      try {
        navResult = await page.navigate({ url });
      } catch {
        throw new Error("CDP Page.navigate command failed without retained protocol metadata.");
      }

      if (typeof navResult.errorText === "string" && navResult.errorText.length > 0) {
        throw new Error("CDP Page.navigate reported a navigation error.");
      }

      if (typeof navResult.frameId === "string") {
        targetFrameId = navResult.frameId;
        if (stoppedFrameIds.has(targetFrameId)) {
          matchingFrameStopped = true;
          checkSettlement();
        }
      }

      while (!loadEventFired || !matchingFrameStopped) {
        throwIfAborted(signal);
        await Promise.race([settlementPromise, delay(50, signal)]);
      }

      let routeConfirmed = false;
      while (!routeConfirmed) {
        throwIfAborted(signal);
        let frameTree: { frameTree: { frame: { id: string; loaderId?: string; url: string } } };
        try {
          frameTree = await page.getFrameTree();
        } catch {
          throw new Error("CDP Page.getFrameTree failed without retained protocol metadata.");
        }
        if (routeMatchesExpected(frameTree.frameTree.frame.url, expectedRoute)) {
          routeConfirmed = true;
          break;
        }
        await delay(50, signal);
      }
    } finally {
      for (const unsub of unsubscribers) {
        try {
          unsub();
        } catch {
          // Dispose all subscriptions cleanly
        }
      }
    }
  }

  public async getReadinessSnapshot(
    expectedRoute: RouteExpectation,
  ): Promise<ExistingReadinessSnapshot> {
    if (this.closed || !this.readinessInitialized) {
      throw new Error("CDP readiness observation is unavailable.");
    }

    const frameTree = await this.client.Page.getFrameTree();
    const mainFrame = frameTree.frameTree.frame;
    const axTree = await this.client.Accessibility.getFullAXTree({ frameId: mainFrame.id });
    const eligibleEditables = axTree.nodes
      .map(toEligibleComposer)
      .filter((target): target is EligibleComposerTarget => target !== null)
      .map(toReadinessEditable);

    return Object.freeze({
      mainFrame: Object.freeze({
        frameId: mainFrame.id,
        loaderId: mainFrame.loaderId,
        expectedRoute: routeMatchesExpected(mainFrame.url, expectedRoute),
      }),
      eligibleEditables: Object.freeze(eligibleEditables),
      backendActivity: Object.freeze({
        activeCount: this.activeRelevantRequestIds.size,
        activityEpoch: this.activityEpoch,
      }),
    });
  }

  public async focusBackendNode(backendDOMNodeId: number): Promise<void> {
    if (this.closed) {
      throw new Error("CDP session is closed.");
    }
    await this.client.DOM.focus({ backendNodeId: backendDOMNodeId });
  }

  public async getTurnComposerState(
    expectedRoute: RouteExpectation,
  ): Promise<CdpTurnComposerState> {
    if (this.closed || !this.readinessInitialized) {
      throw new Error("CDP turn observation is unavailable.");
    }
    const frameTree = await this.client.Page.getFrameTree();
    const mainFrame = frameTree.frameTree.frame;
    const routeValid = routeMatchesExpected(mainFrame.url, expectedRoute);
    const axTree = await this.client.Accessibility.getFullAXTree({ frameId: mainFrame.id });
    const eligible = axTree.nodes
      .map(toEligibleComposer)
      .filter((target): target is EligibleComposerTarget => target !== null);

    if (eligible.length !== 1) {
      return Object.freeze({
        expectedRoute: routeValid,
        eligible: false,
        focused: false,
        empty: false,
      });
    }

    const target = eligible[0]!;
    return Object.freeze({
      expectedRoute: routeValid,
      eligible: true,
      focused: target.focused,
      empty: target.empty,
      backendDOMNodeId: target.backendDOMNodeId,
    });
  }

  public async captureTurnResponseRenderBaseline(): Promise<CdpResponseRenderBaseline> {
    if (this.closed || !this.readinessInitialized) {
      throw new Error("CDP response render observation is unavailable.");
    }

    const expression = `(() => {
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(RENDERED_MESSAGE_SELECTOR)}));
      let userCount = 0;
      let assistantCount = 0;
      for (const node of nodes) {
        const role = node.getAttribute("data-message-author-role");
        if (role === "user") userCount += 1;
        if (role === "assistant") assistantCount += 1;
      }
      return { userCount, assistantCount };
    })()`;

    let result: Awaited<ReturnType<CriClient["Runtime"]["evaluate"]>>;
    try {
      result = await this.client.Runtime.evaluate({ expression, returnByValue: true });
    } catch {
      throw new Error("CDP rendered response baseline observation failed.");
    }
    if (result.exceptionDetails !== undefined) {
      throw new Error("CDP rendered response baseline observation failed.");
    }

    const value = result.result.value as unknown;
    if (
      !isObject(value) ||
      !isNonNegativeSafeInteger(value.userCount) ||
      !isNonNegativeSafeInteger(value.assistantCount)
    ) {
      throw new Error("CDP rendered response baseline observation was malformed.");
    }

    return Object.freeze({
      userCount: value.userCount,
      assistantCount: value.assistantCount,
    });
  }

  public async getFinalRenderedAssistantSnapshot(
    baseline: CdpResponseRenderBaseline,
    expectedRoute: RouteExpectation,
  ): Promise<CdpFinalRenderedAssistantSnapshot | null> {
    if (this.closed || !this.readinessInitialized) {
      throw new Error("CDP final rendered response observation is unavailable.");
    }
    if (
      !isNonNegativeSafeInteger(baseline.userCount) ||
      !isNonNegativeSafeInteger(baseline.assistantCount)
    ) {
      throw new TypeError("Rendered response baseline is invalid.");
    }

    let routeValid = false;
    try {
      const frameTree = await this.client.Page.getFrameTree();
      routeValid = routeMatchesExpected(frameTree.frameTree.frame.url, expectedRoute);
    } catch {
      throw new Error("CDP final rendered response route observation failed.");
    }
    if (!routeValid) {
      return null;
    }

    const expression = `(() => {
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(RENDERED_MESSAGE_SELECTOR)}));
      const roles = nodes.map((node) => node.getAttribute("data-message-author-role"));
      const userCount = roles.filter((role) => role === "user").length;
      const assistantCount = roles.filter((role) => role === "assistant").length;
      if (userCount !== ${baseline.userCount + 1} || assistantCount !== ${baseline.assistantCount + 1}) {
        return { state: "NOT_READY" };
      }
      if (roles.length < 2 || roles[roles.length - 2] !== "user" || roles[roles.length - 1] !== "assistant") {
        return { state: "NOT_READY" };
      }
      const lastUserIndex = roles.lastIndexOf("user");
      if (lastUserIndex < 0) return { state: "NOT_READY" };
      const rolesAfterLastUser = roles.slice(lastUserIndex + 1);
      if (
        rolesAfterLastUser.filter((role) => role === "assistant").length !== 1 ||
        rolesAfterLastUser.some((role) => role === "user")
      ) {
        return { state: "NOT_READY" };
      }
      const assistantNode = nodes[nodes.length - 1];
      if (!(assistantNode instanceof HTMLElement)) return { state: "NOT_READY" };
      const text = assistantNode.innerText;
      if (typeof text !== "string" || text.trim().length === 0) return { state: "NOT_READY" };
      if (text.length > ${MAX_FINAL_RENDERED_TEXT_CHARS}) return { state: "TOO_LARGE" };
      return { state: "READY", text };
    })()`;

    let result: Awaited<ReturnType<CriClient["Runtime"]["evaluate"]>>;
    try {
      result = await this.client.Runtime.evaluate({ expression, returnByValue: true });
    } catch {
      throw new Error("CDP final rendered response observation failed.");
    }
    if (result.exceptionDetails !== undefined) {
      throw new Error("CDP final rendered response observation failed.");
    }

    const value = result.result.value as unknown;
    if (!isObject(value) || typeof value.state !== "string") {
      throw new Error("CDP final rendered response observation was malformed.");
    }
    if (value.state === "NOT_READY") {
      return null;
    }
    if (value.state === "TOO_LARGE") {
      throw new Error("The final rendered assistant response exceeded its bounded capacity.");
    }
    if (
      value.state !== "READY" ||
      typeof value.text !== "string" ||
      value.text.length === 0 ||
      value.text.length > MAX_FINAL_RENDERED_TEXT_CHARS
    ) {
      throw new Error("CDP final rendered response observation was malformed.");
    }

    return Object.freeze({ text: value.text });
  }

  public armTurnObservation(options: CdpTurnObservationOptions = {}): CdpTurnObservationHandle {
    if (this.closed || !this.readinessInitialized) {
      throw new Error("CDP turn observation is unavailable.");
    }
    return this.turnObservation.armTurnObservation(options);
  }

  public getTurnObservation(handle: CdpTurnObservationHandle): CdpTurnObservationSnapshot {
    return this.turnObservation.getTurnObservation(handle);
  }

  public takeTurnResponseEvents(handle: CdpTurnObservationHandle): readonly NormalizedResponseStreamEvent[] {
    return this.turnObservation.takeTurnResponseEvents(handle);
  }

  public discardTurnResponse(handle: CdpTurnObservationHandle): void {
    this.turnObservation.discardTurnResponse(handle);
  }

  public releaseTurnObservation(handle: CdpTurnObservationHandle): void {
    this.turnObservation.releaseTurnObservation(handle);
  }

  public async insertText(text: string): Promise<void> {
    if (this.closed) {
      throw new Error("CDP session is closed.");
    }
    try {
      await this.client.Input.insertText({ text });
    } catch {
      throw new Error("CDP insertText command failed without retained protocol metadata.");
    }
  }

  public async dispatchEnterKeyDown(): Promise<void> {
    await this.dispatchEnter("keyDown");
  }

  public async dispatchEnterKeyUp(): Promise<void> {
    await this.dispatchEnter("keyUp");
  }

  public async clickTurnSendButton(
    projectLocator: ProjectLocator,
    backendDOMNodeId: number,
    formBackendDOMNodeId: number,
    expectedText: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const clicked = await this.clickProjectComposerSend(
      projectLocator,
      backendDOMNodeId,
      formBackendDOMNodeId,
      expectedText,
      signal,
    );
    if (!clicked) {
      throw new Error("The unique enabled turn send control was unavailable.");
    }
  }

  public async insertTextIntoProjectComposer(
    text: string,
    projectLocator: ProjectLocator,
    backendDOMNodeId: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const formBackendDOMNodeId = await this.insertProjectComposerText(
      projectLocator,
      backendDOMNodeId,
      text,
      signal,
    );
    if (formBackendDOMNodeId === null) {
      throw new Error("The expected Project composer was unavailable for input.");
    }
    return formBackendDOMNodeId;
  }

  public async getCurrentConversationLocator(): Promise<ConversationLocator | null> {
    if (this.closed) {
      throw new Error("CDP session is closed.");
    }
    const frameTree = await this.client.Page.getFrameTree();
    try {
      return createConversationLocator(frameTree.frameTree.frame.url);
    } catch {
      return null;
    }
  }

  public async createProjectThroughUi(
    name: ProjectName,
    signal?: AbortSignal,
    onMutationAttempted?: () => void,
  ): Promise<ProjectLocator> {
    if (this.closed || !this.readinessInitialized) {
      throw new Error("CDP project UI operation is unavailable.");
    }
    throwIfAborted(signal);
    const initialFrameTree = await this.client.Page.getFrameTree();
    let initialLocator: ProjectLocator | null = null;
    try {
      initialLocator = createProjectLocator(initialFrameTree.frameTree.frame.url);
    } catch {
      // Project creation may begin from any supported ChatGPT route.
    }
    const opened = await this.evaluateProjectBoolean(`(() => {
      const visible = (element) => element instanceof HTMLElement && element.offsetParent !== null;
      const controls = Array.from(document.querySelectorAll('button, [role="button"]'));
      const matches = controls.filter((control) => {
        const label = (control.getAttribute('aria-label') ?? '').toLocaleLowerCase();
        return ['new project', 'create project', 'novo projeto', 'criar projeto'].includes(label) &&
          visible(control) && control.closest('nav, [role="navigation"]') !== null;
      });
      if (matches.length !== 1) return false;
      matches[0].click();
      return true;
    })()`);
    if (!opened) {
      throw new Error("Project creation control was unavailable.");
    }

    let inputFocused = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      throwIfAborted(signal);
      inputFocused = await this.evaluateProjectBoolean(`(() => {
        const visible = (element) => element instanceof HTMLElement && element.offsetParent !== null;
        const controls = Array.from(document.querySelectorAll('button, [role="button"]')).filter((control) => {
          const signal = [control.getAttribute('aria-label'), control.getAttribute('title'), control.getAttribute('data-testid')]
            .filter(Boolean).join(' ').toLocaleLowerCase();
          return (signal.includes('project') || signal.includes('projeto')) &&
            control.closest('nav, [role="navigation"]') === null && visible(control);
        });
        let surface = controls[0]?.parentElement ?? null;
        while (surface !== null && !controls.every((control) => surface.contains(control))) surface = surface.parentElement;
        if (surface === null) return false;
        const inputs = Array.from(surface.querySelectorAll('input[type="text"]')).filter(visible);
        if (inputs.length !== 1) return false;
        inputs[0].focus();
        return true;
      })()`);
      if (inputFocused) break;
      await delay(100, signal);
    }
    if (!inputFocused) {
      throw new Error("Project name input was unavailable.");
    }

    throwIfAborted(signal);
    try {
      await this.client.Input.insertText({ text: name });
    } catch {
      throw new Error("Project name input failed without retained protocol metadata.");
    }

    let confirmed = false;
    onMutationAttempted?.();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      throwIfAborted(signal);
      confirmed = await this.evaluateProjectBoolean(`(() => {
        const visible = (element) => element instanceof HTMLElement && element.offsetParent !== null;
        const inputs = Array.from(document.querySelectorAll('input[type="text"]')).filter(visible);
        const matchingInputs = inputs.filter((input) => input.value === ${JSON.stringify(name)});
        if (matchingInputs.length !== 1) return false;
        let surface = matchingInputs[0].parentElement;
        while (surface !== null) {
          const buttons = Array.from(surface.querySelectorAll('button, [role="button"]')).filter(visible);
          const matches = buttons.filter((button) => {
            const text = (button.textContent ?? '').trim().toLocaleLowerCase();
            return (text.includes('create') || text.includes('criar')) &&
              (text.includes('project') || text.includes('projeto'));
          });
          if (matches.length === 1) {
            const button = matches[0];
            if ((button instanceof HTMLButtonElement && button.disabled) || button.getAttribute('aria-disabled') === 'true') return false;
            button.click();
            return true;
          }
          surface = surface.parentElement;
        }
        return false;
      })()`);
      if (confirmed) break;
      await delay(100, signal);
    }
    if (!confirmed) {
      throw new Error("Project creation confirmation was unavailable.");
    }

    for (let attempt = 0; attempt < 200; attempt += 1) {
      throwIfAborted(signal);
      const frameTree = await this.client.Page.getFrameTree();
      let locator: ProjectLocator;
      try {
        locator = createProjectLocator(frameTree.frameTree.frame.url);
      } catch {
        await delay(100, signal);
        continue;
      }
      if (locator === initialLocator) {
        await delay(100, signal);
        continue;
      }
      const nameVisible = await this.evaluateProjectBoolean(`(() =>
        Array.from(document.querySelectorAll('h1, h2')).some((heading) =>
          (heading.textContent ?? '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(name)}
        )
      )()`);
      if (nameVisible) {
        return locator;
      }
      await delay(100, signal);
    }
    throw new Error("Project creation postcondition was not observed.");
  }

  private async evaluateProjectBoolean(expression: string): Promise<boolean> {
    let result: Awaited<ReturnType<CriClient["Runtime"]["evaluate"]>>;
    try {
      result = await this.client.Runtime.evaluate({ expression, returnByValue: true });
    } catch {
      throw new Error("CDP project UI observation failed without retained protocol metadata.");
    }
    if (result.exceptionDetails !== undefined || typeof result.result.value !== "boolean") {
      throw new Error("CDP project UI observation was malformed.");
    }
    return result.result.value;
  }

  private async insertProjectComposerText(
    projectLocator: ProjectLocator,
    backendDOMNodeId: number,
    text: string,
    signal?: AbortSignal,
  ): Promise<number | null> {
    const { dom, runtime } = this.projectComposerDomains(backendDOMNodeId, signal);
    const objectIds: string[] = [];
    let operationFailed = false;
    let formBackendDOMNodeId: number | null = null;
    try {
      const composer = await dom.resolveNode({ backendNodeId: backendDOMNodeId });
      const composerObjectId = composer.object.objectId;
      if (typeof composerObjectId !== "string" || composerObjectId.length === 0) {
        throw new Error("Project composer identity could not be resolved.");
      }
      objectIds.push(composerObjectId);
      throwIfAborted(signal);
      const result = await runtime.callFunctionOn({
        objectId: composerObjectId,
        functionDeclaration: `function(expectedHref, text) {
          const visible = (element) => element instanceof HTMLElement && element.offsetParent !== null;
          const expected = new URL(expectedHref);
          const currentPath = location.pathname.endsWith('/') ? location.pathname.slice(0, -1) : location.pathname;
          if (location.origin !== expected.origin || currentPath !== expected.pathname ||
              location.search !== '' || location.hash !== '' || this !== document.activeElement ||
              !(this instanceof HTMLElement) || !visible(this) ||
              !(this.matches('textarea, [contenteditable="true"]') || this.getAttribute('role') === 'textbox')) {
            return null;
          }
          const form = this.closest('form');
          if (form === null || typeof text !== 'string' || text.length === 0) return null;
          const content = this instanceof HTMLTextAreaElement || this instanceof HTMLInputElement
            ? this.value
            : this.textContent;
          if (content !== null && content.length !== 0) return null;
          this.focus();
          if (this instanceof HTMLTextAreaElement || this instanceof HTMLInputElement) {
            const prototype = this instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            if (setter === undefined) return null;
            setter.call(this, text);
          } else if (this.isContentEditable) {
            this.textContent = text;
          } else {
            return null;
          }
          this.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            data: text,
            inputType: 'insertText',
          }));
          const inserted = this instanceof HTMLTextAreaElement || this instanceof HTMLInputElement
            ? this.value
            : this.textContent;
          return inserted === text ? form : null;
        }`,
        arguments: [{ value: projectLocator }, { value: text }],
        returnByValue: false,
      });
      const formObjectId = result.result.objectId;
      if (typeof formObjectId === "string") {
        objectIds.push(formObjectId);
      }
      throwIfAborted(signal);
      if (result.exceptionDetails !== undefined || typeof formObjectId !== "string") {
        formBackendDOMNodeId = null;
      } else {
        const described = await dom.describeNode({ objectId: formObjectId });
        throwIfAborted(signal);
        const candidate = described.node.backendNodeId;
        if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) {
          formBackendDOMNodeId = candidate;
        }
      }
    } catch {
      operationFailed = true;
    }

    await this.releaseProjectComposerObjects(runtime, objectIds);
    if (operationFailed) {
      throw new Error("CDP Project composer operation failed without retained protocol metadata.");
    }
    return formBackendDOMNodeId;
  }

  private async clickProjectComposerSend(
    projectLocator: ProjectLocator,
    backendDOMNodeId: number,
    formBackendDOMNodeId: number,
    text: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { dom, runtime } = this.projectComposerDomains(backendDOMNodeId, signal);
    if (!Number.isSafeInteger(formBackendDOMNodeId) || formBackendDOMNodeId <= 0) {
      throw new TypeError("Project turn form identity is invalid.");
    }
    const objectIds: string[] = [];
    let operationFailed = false;
    let clicked = false;
    try {
      const composer = await dom.resolveNode({ backendNodeId: backendDOMNodeId });
      const composerObjectId = composer.object.objectId;
      if (typeof composerObjectId !== "string" || composerObjectId.length === 0) {
        throw new Error("Project composer identity could not be resolved.");
      }
      objectIds.push(composerObjectId);
      throwIfAborted(signal);
      const form = await dom.resolveNode({ backendNodeId: formBackendDOMNodeId });
      const formObjectId = form.object.objectId;
      if (typeof formObjectId !== "string" || formObjectId.length === 0) {
        throw new Error("Project composer identity could not be resolved.");
      }
      objectIds.push(formObjectId);
      throwIfAborted(signal);
      const result = await runtime.callFunctionOn({
        objectId: composerObjectId,
        functionDeclaration: `function(expectedHref, expectedForm, text) {
          const visible = (element) => element instanceof HTMLElement && element.offsetParent !== null;
          const expected = new URL(expectedHref);
          const currentPath = location.pathname.endsWith('/') ? location.pathname.slice(0, -1) : location.pathname;
          if (location.origin !== expected.origin || currentPath !== expected.pathname ||
              location.search !== '' || location.hash !== '' || this !== document.activeElement ||
              !(this instanceof HTMLElement) || !visible(this) ||
              !(expectedForm instanceof HTMLFormElement) || this.closest('form') !== expectedForm ||
              !(this.matches('textarea, [contenteditable="true"]') || this.getAttribute('role') === 'textbox')) {
            return false;
          }
          const inserted = this instanceof HTMLTextAreaElement || this instanceof HTMLInputElement
            ? this.value
            : this.textContent;
          if (typeof text !== 'string' || text.length === 0 || inserted !== text) return false;
          const matches = Array.from(expectedForm.querySelectorAll('button[data-testid="send-button"]'))
            .filter((button) => visible(button) && button instanceof HTMLButtonElement &&
              button.form === expectedForm && !button.disabled &&
              button.getAttribute('aria-disabled') !== 'true');
          if (matches.length !== 1) return false;
          matches[0].click();
          return true;
        }`,
        arguments: [
          { value: projectLocator },
          { objectId: formObjectId },
          { value: text },
        ],
        returnByValue: true,
      });
      throwIfAborted(signal);
      if (result.exceptionDetails !== undefined || typeof result.result.value !== "boolean") {
        throw new Error("Project composer identity observation was malformed.");
      }
      clicked = result.result.value;
    } catch {
      operationFailed = true;
    }

    await this.releaseProjectComposerObjects(runtime, objectIds);
    if (operationFailed) {
      throw new Error("CDP Project composer operation failed without retained protocol metadata.");
    }
    return clicked;
  }

  private projectComposerDomains(backendDOMNodeId: number, signal?: AbortSignal) {
    throwIfAborted(signal);
    if (this.closed || !this.readinessInitialized) {
      throw new Error("CDP Project composer operation is unavailable.");
    }
    if (!Number.isSafeInteger(backendDOMNodeId) || backendDOMNodeId <= 0) {
      throw new TypeError("Project turn composer identity is invalid.");
    }
    const dom = this.client.DOM as unknown as {
      resolveNode(params: { backendNodeId: number }): Promise<{
        object: { objectId?: string };
      }>;
      describeNode(params: { objectId: string }): Promise<{
        node: { backendNodeId?: number };
      }>;
    };
    const runtime = this.client.Runtime as unknown as {
      callFunctionOn(params: Readonly<Record<string, unknown>>): Promise<{
        result: { value?: unknown; objectId?: string };
        exceptionDetails?: unknown;
      }>;
      releaseObject(params: Readonly<{ objectId: string }>): Promise<void>;
    };
    if (
      typeof dom.resolveNode !== "function" ||
      typeof dom.describeNode !== "function" ||
      typeof runtime.callFunctionOn !== "function" ||
      typeof runtime.releaseObject !== "function"
    ) {
      throw new Error("CDP Project composer identity observation is unavailable.");
    }
    return { dom, runtime };
  }

  private async releaseProjectComposerObjects(
    runtime: { releaseObject(params: Readonly<{ objectId: string }>): Promise<void> },
    objectIds: readonly string[],
  ): Promise<void> {
    let cleanupFailed = false;
    for (const objectId of [...objectIds].reverse()) {
      try {
        await runtime.releaseObject({ objectId });
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      await this.close().catch(() => undefined);
      throw new Error("CDP Project composer cleanup failed without retained protocol metadata.");
    }
  }

  private async dispatchEnter(type: "keyDown" | "keyUp"): Promise<void> {
    if (this.closed) {
      throw new Error("CDP session is closed.");
    }
    try {
      await this.client.Input.dispatchKeyEvent({
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    } catch {
      throw new Error("CDP Enter command failed without retained protocol metadata.");
    }
  }

  private readonly handleDisconnect = (): void => {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.disposeReadinessObservation();
    const listeners = [...this.disconnectListeners];
    this.disconnectListeners.clear();
    for (const listener of listeners) {
      listener();
    }
  };

  private onRequestWillBeSent(
    requestId: string,
    rawUrl: string,
    method: string | undefined,
    redirectedFromPreviousRequest: boolean,
  ): void {
    const relevant = isRelevantBackendUrl(rawUrl);
    const wasRelevant = this.activeRelevantRequestIds.has(requestId);
    if (relevant && !wasRelevant) {
      this.activeRelevantRequestIds.add(requestId);
      this.activityEpoch += 1;
    } else if (!relevant && wasRelevant) {
      this.activeRelevantRequestIds.delete(requestId);
      this.activityEpoch += 1;
    }
    this.turnObservation.onRequestWillBeSent(
      requestId,
      rawUrl,
      method,
      redirectedFromPreviousRequest,
    );
  }

  private onResponseReceived(requestId: string, status: number): void {
    this.turnObservation.onResponseReceived(requestId, status);
  }

  private onDataReceived(event: import("./ChromeRemoteInterfaceHelpers.js").ExperimentalDataReceivedEvent): void {
    this.turnObservation.onDataReceived(event);
  }

  private onRequestSettled(requestId: string, failed: boolean): void {
    if (this.activeRelevantRequestIds.delete(requestId)) {
      this.activityEpoch += 1;
    }
    this.turnObservation.onRequestSettled(requestId, failed);
  }

  private disposeReadinessObservation(): void {
    for (const unsubscribe of this.readinessUnsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // Cleanup is best-effort; no protocol payload is retained.
      }
    }
    this.activeRelevantRequestIds.clear();
    this.turnObservation.dispose();
    this.activityEpoch = 0;
    this.responseDataObservationAvailable = false;
    this.readinessInitialized = false;
  }
}
