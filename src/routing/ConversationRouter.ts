import {
  CHATGPT_ORIGIN,
  ConversationLocator,
  ThreadHandle,
} from "../domain/ThreadIdentity.js";
import { RuntimeLease } from "../domain/RuntimeGeneration.js";
import {
  OperationAbortedError,
  RouteNavigationFailedError,
  RuntimeGenerationChangedError,
} from "../domain/errors.js";
import { OperationScheduler } from "./OperationScheduler.js";
import { ThreadRegistry } from "./ThreadRegistry.js";

export const CHATGPT_FRESH_ROUTE = `${CHATGPT_ORIGIN}/`;

export interface ConversationNavigationPort {
  navigate(url: string, signal?: AbortSignal): Promise<void>;
}

export interface ConversationReadinessPort {
  waitForExistingRoute(
    expectedLocator: ConversationLocator,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void>;
  waitForFreshRoute(
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void>;
}

export type ExistingConversationRouteResult = Readonly<{
  kind: "THREAD";
  threadHandle: ThreadHandle;
}>;
export type FreshConversationRouteResult = Readonly<{ kind: "FRESH" }>;
export type ConversationRouteResult = ExistingConversationRouteResult | FreshConversationRouteResult;

export class ConversationRouter {
  public constructor(
    private readonly registry: ThreadRegistry,
    private readonly scheduler: OperationScheduler,
    private readonly navigation: ConversationNavigationPort,
    private readonly readiness: ConversationReadinessPort,
  ) {}

  public async routeToThread(
    handle: ThreadHandle,
    signal?: AbortSignal,
  ): Promise<ExistingConversationRouteResult> {
    const locator = this.registry.resolve(handle);
    return await this.scheduler.schedule(
      "ROUTE",
      async (operationSignal, lease) => {
        await this.navigate(locator, operationSignal);
        await this.readiness.waitForExistingRoute(locator, lease, operationSignal);
        return Object.freeze({ kind: "THREAD" as const, threadHandle: handle });
      },
      signal ? { signal } : {},
    );
  }

  public async routeFresh(signal?: AbortSignal): Promise<FreshConversationRouteResult> {
    return await this.scheduler.schedule(
      "ROUTE",
      async (operationSignal, lease) => {
        await this.navigate(CHATGPT_FRESH_ROUTE, operationSignal);
        await this.readiness.waitForFreshRoute(lease, operationSignal);
        return Object.freeze({ kind: "FRESH" as const });
      },
      signal ? { signal } : {},
    );
  }

  private async navigate(url: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.navigation.navigate(url, signal);
    } catch (error) {
      if (error instanceof RuntimeGenerationChangedError || error instanceof OperationAbortedError) {
        throw error;
      }
      if (error instanceof RouteNavigationFailedError) {
        throw error;
      }
      throw new RouteNavigationFailedError(undefined, { cause: error });
    }
  }
}
