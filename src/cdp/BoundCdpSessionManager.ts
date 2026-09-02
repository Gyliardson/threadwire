import { ControllerConfig } from "../config/ControllerConfig.js";
import { ProjectLocator, ProjectName } from "../domain/ProjectIdentity.js";
import { RuntimeLease, RuntimeLeaseSource, sameRuntimeLease } from "../domain/RuntimeGeneration.js";
import { ConversationLocator } from "../domain/ThreadIdentity.js";
import { RuntimeGenerationChangedError } from "../domain/errors.js";
import { RouteExpectation } from "../readiness/types.js";
import { RuntimeProvenanceGuard } from "../runtime/BoundRuntimeProvenanceGuard.js";
import { currentOperationSignal, throwIfAborted } from "../utils/timeout.js";
import { ChromeRemoteInterfaceTransport } from "./ChromeRemoteInterfaceTransport.js";
import { assertTargetDebuggerEndpoint } from "./CdpEndpointBinding.js";
import {
  CdpSessionManager,
  CdpSessionManagerOptions,
  CdpTargetDiscoveryLike,
} from "./CdpSessionManager.js";
import { CdpTargetDiscovery, FindPrimaryTargetOptions } from "./CdpTargetDiscovery.js";
import {
  CdpTransport,
  CdpTransportConnectOptions,
  CdpTransportSession,
} from "./CdpTransport.js";

function authoritySignal(signal?: AbortSignal): AbortSignal | undefined {
  return currentOperationSignal() ?? signal;
}

async function assertGuardCurrent(
  guard: RuntimeProvenanceGuard,
  lease: RuntimeLease,
  signal?: AbortSignal,
): Promise<void> {
  const effectiveSignal = authoritySignal(signal);
  throwIfAborted(effectiveSignal);
  await guard.assertCurrent(lease, effectiveSignal);
  throwIfAborted(effectiveSignal);
}

class GuardedDiscovery implements CdpTargetDiscoveryLike {
  public constructor(
    private readonly inner: CdpTargetDiscoveryLike,
    private readonly config: ControllerConfig,
    private readonly getLease: () => RuntimeLease,
    private readonly guard: RuntimeProvenanceGuard,
  ) {}

  public async findPrimaryTarget(options: FindPrimaryTargetOptions = {}) {
    const lease = this.getLease();
    await assertGuardCurrent(this.guard, lease, options.signal);
    const target = await this.inner.findPrimaryTarget(options);
    assertTargetDebuggerEndpoint(target, this.config);
    await assertGuardCurrent(this.guard, lease, options.signal);
    return target;
  }
}

class GuardedTransport implements CdpTransport {
  public constructor(
    private readonly inner: CdpTransport,
    private readonly getLease: () => RuntimeLease,
    private readonly guard: RuntimeProvenanceGuard,
  ) {}

  public async connect(options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    const lease = this.getLease();
    await assertGuardCurrent(this.guard, lease, options.signal);
    const session = await this.inner.connect({
      ...options,
      beforeMutation: async (mutationSignal) => {
        await assertGuardCurrent(this.guard, lease, mutationSignal);
      },
    });
    try {
      await assertGuardCurrent(this.guard, lease, options.signal);
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
    return this.wrapReadiness(session, lease, options.signal);
  }

  private wrapReadiness(
    session: CdpTransportSession,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): CdpTransportSession {
    const guard = this.guard;
    return new Proxy(session, {
      get(target, property) {
        if (property === "initializeReadinessObservation") {
          return async () => {
            await assertGuardCurrent(guard, lease, signal);
            try {
              await target.initializeReadinessObservation();
              await assertGuardCurrent(guard, lease, signal);
            } catch (error) {
              await target.close().catch(() => undefined);
              throw error;
            }
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}

export class BoundCdpSessionManager extends CdpSessionManager {
  private immutableLease: RuntimeLease | null = null;

  public constructor(
    config: ControllerConfig,
    runtime: RuntimeLeaseSource,
    private readonly provenanceGuard: RuntimeProvenanceGuard,
    options: CdpSessionManagerOptions = {},
  ) {
    let getLease: () => RuntimeLease = () => {
      throw new RuntimeGenerationChangedError();
    };
    const discovery = new GuardedDiscovery(
      options.discovery ?? new CdpTargetDiscovery(config),
      config,
      () => getLease(),
      provenanceGuard,
    );
    const transport = new GuardedTransport(
      options.transport ?? new ChromeRemoteInterfaceTransport(),
      () => getLease(),
      provenanceGuard,
    );
    super(config, runtime, { ...options, discovery, transport });
    getLease = () => this.requireImmutableLease();
  }

  public async bindExistingRuntime(lease: RuntimeLease, signal?: AbortSignal): Promise<void> {
    const effectiveSignal = authoritySignal(signal);
    throwIfAborted(effectiveSignal);
    if (this.immutableLease === null) {
      this.immutableLease = lease;
      await this.provenanceGuard.bind(lease, effectiveSignal);
      throwIfAborted(effectiveSignal);
    } else if (!sameRuntimeLease(this.immutableLease, lease)) {
      throw new RuntimeGenerationChangedError();
    }
    await this.connect(effectiveSignal);
  }

  public override async connect(signal?: AbortSignal): Promise<void> {
    const lease = this.requireImmutableLease();
    const effectiveSignal = await this.guardCurrent(signal);
    try {
      await super.connect(effectiveSignal);
      await this.guardCurrent(effectiveSignal);
      super.assertCurrentRuntime();
    } catch (error) {
      await super.disconnect().catch(() => undefined);
      throw error;
    }
  }

  public async assertBoundRuntimeCurrent(
    expectedLease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    const lease = this.requireImmutableLease();
    if (!sameRuntimeLease(lease, expectedLease)) {
      throw new RuntimeGenerationChangedError();
    }
    await this.guardCurrent(signal);
    super.assertCurrentRuntime();
  }

  public override async navigate(url: string, signal?: AbortSignal): Promise<void> {
    const effectiveSignal = await this.guardBeforeMutation(signal);
    await super.navigate(url, effectiveSignal);
  }

  public override async reload(signal?: AbortSignal): Promise<void> {
    const effectiveSignal = await this.guardBeforeMutation(signal);
    await super.reload(effectiveSignal);
  }

  public override async navigateAndWaitForLoadSettlement(
    url: string,
    expectedRoute: RouteExpectation,
    signal?: AbortSignal,
  ): Promise<void> {
    const effectiveSignal = await this.guardBeforeMutation(signal);
    await super.navigateAndWaitForLoadSettlement(url, expectedRoute, effectiveSignal);
  }

  public override async focusBackendNode(
    backendDOMNodeId: number,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    const effectiveSignal = await this.guardExpectedLease(lease, signal);
    await super.focusBackendNode(backendDOMNodeId, lease, effectiveSignal);
  }

  public override async insertText(
    text: string,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    const effectiveSignal = await this.guardExpectedLease(lease, signal);
    await super.insertText(text, lease, effectiveSignal);
  }

  public override async insertTextIntoProjectComposer(
    text: string,
    projectLocator: ProjectLocator,
    backendDOMNodeId: number,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<number> {
    const effectiveSignal = await this.guardExpectedLease(lease, signal);
    return await super.insertTextIntoProjectComposer(
      text,
      projectLocator,
      backendDOMNodeId,
      lease,
      effectiveSignal,
    );
  }

  public override async dispatchEnterKeyDown(
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    const effectiveSignal = await this.guardExpectedLease(lease, signal);
    await super.dispatchEnterKeyDown(lease, effectiveSignal);
  }

  public override async dispatchEnterKeyUp(
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    const effectiveSignal = await this.guardExpectedLease(lease, signal);
    await super.dispatchEnterKeyUp(lease, effectiveSignal);
  }

  public override async clickTurnSendButton(
    projectLocator: ProjectLocator,
    backendDOMNodeId: number,
    formBackendDOMNodeId: number,
    expectedText: string,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    const effectiveSignal = await this.guardExpectedLease(lease, signal);
    await super.clickTurnSendButton(
      projectLocator,
      backendDOMNodeId,
      formBackendDOMNodeId,
      expectedText,
      lease,
      effectiveSignal,
    );
  }

  public override async clickExistingTurnSendButton(
    conversationLocator: ConversationLocator,
    backendDOMNodeId: number,
    expectedText: string,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    const effectiveSignal = await this.guardExpectedLease(lease, signal);
    await super.clickExistingTurnSendButton(
      conversationLocator,
      backendDOMNodeId,
      expectedText,
      lease,
      effectiveSignal,
    );
  }

  public override async createProjectThroughUi(
    name: ProjectName,
    lease: RuntimeLease,
    signal?: AbortSignal,
    onMutationAttempted?: () => void,
  ): Promise<ProjectLocator> {
    const effectiveSignal = await this.guardExpectedLease(lease, signal);
    return await super.createProjectThroughUi(name, lease, effectiveSignal, onMutationAttempted);
  }

  private requireImmutableLease(): RuntimeLease {
    if (this.immutableLease === null) {
      throw new RuntimeGenerationChangedError();
    }
    return this.immutableLease;
  }

  private async guardCurrent(signal?: AbortSignal): Promise<AbortSignal | undefined> {
    const effectiveSignal = authoritySignal(signal);
    await assertGuardCurrent(this.provenanceGuard, this.requireImmutableLease(), effectiveSignal);
    return effectiveSignal;
  }

  private async guardBeforeMutation(signal?: AbortSignal): Promise<AbortSignal | undefined> {
    return await this.guardCurrent(signal);
  }

  private async guardExpectedLease(
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<AbortSignal | undefined> {
    const expected = this.requireImmutableLease();
    if (!sameRuntimeLease(expected, lease)) {
      throw new RuntimeGenerationChangedError();
    }
    const effectiveSignal = authoritySignal(signal);
    await assertGuardCurrent(this.provenanceGuard, expected, effectiveSignal);
    return effectiveSignal;
  }
}
