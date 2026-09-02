import { ControllerConfig } from "../config/ControllerConfig.js";
import { ProjectLocator, ProjectName } from "../domain/ProjectIdentity.js";
import { RuntimeLease, RuntimeLeaseSource, sameRuntimeLease } from "../domain/RuntimeGeneration.js";
import { ConversationLocator } from "../domain/ThreadIdentity.js";
import { RuntimeGenerationChangedError } from "../domain/errors.js";
import { RouteExpectation } from "../readiness/types.js";
import { RuntimeProvenanceGuard } from "../runtime/BoundRuntimeProvenanceGuard.js";
import { throwIfAborted } from "../utils/timeout.js";
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

async function assertGuardCurrent(
  guard: RuntimeProvenanceGuard,
  lease: RuntimeLease,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await guard.assertCurrent(lease, signal);
  throwIfAborted(signal);
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
  public readonly boundMutationCancellation = true as const;
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

  protected override rawMutationSignal(signal?: AbortSignal): AbortSignal | undefined {
    return signal;
  }

  public async bindExistingRuntime(lease: RuntimeLease, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.immutableLease === null) {
      this.immutableLease = lease;
      await this.provenanceGuard.bind(lease, signal);
      throwIfAborted(signal);
    } else if (!sameRuntimeLease(this.immutableLease, lease)) {
      throw new RuntimeGenerationChangedError();
    }
    await this.connect(signal);
  }

  public override async connect(signal?: AbortSignal): Promise<void> {
    const lease = this.requireImmutableLease();
    await this.guardCurrent(signal);
    try {
      await super.connect(signal);
      await this.guardCurrent(signal);
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
    await this.guardBeforeMutation(signal);
    await super.navigate(url, signal);
  }

  public override async reload(signal?: AbortSignal): Promise<void> {
    await this.guardBeforeMutation(signal);
    await super.reload(signal);
  }

  public override async navigateAndWaitForLoadSettlement(
    url: string,
    expectedRoute: RouteExpectation,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.guardBeforeMutation(signal);
    await super.navigateAndWaitForLoadSettlement(url, expectedRoute, signal);
  }

  public override async focusBackendNode(
    backendDOMNodeId: number,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.guardExpectedLease(lease, signal);
    await super.focusBackendNode(backendDOMNodeId, lease, signal);
  }

  public override async insertText(
    text: string,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.guardExpectedLease(lease, signal);
    await super.insertText(text, lease, signal);
  }

  public override async insertTextIntoProjectComposer(
    text: string,
    projectLocator: ProjectLocator,
    backendDOMNodeId: number,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<number> {
    await this.guardExpectedLease(lease, signal);
    return await super.insertTextIntoProjectComposer(
      text,
      projectLocator,
      backendDOMNodeId,
      lease,
      signal,
    );
  }

  public override async dispatchEnterKeyDown(
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.guardExpectedLease(lease, signal);
    await super.dispatchEnterKeyDown(lease, signal);
  }

  public override async dispatchEnterKeyUp(
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.guardExpectedLease(lease, signal);
    await super.dispatchEnterKeyUp(lease, signal);
  }

  public override async clickTurnSendButton(
    projectLocator: ProjectLocator,
    backendDOMNodeId: number,
    formBackendDOMNodeId: number,
    expectedText: string,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.guardExpectedLease(lease, signal);
    await super.clickTurnSendButton(
      projectLocator,
      backendDOMNodeId,
      formBackendDOMNodeId,
      expectedText,
      lease,
      signal,
    );
  }

  public override async clickExistingTurnSendButton(
    conversationLocator: ConversationLocator,
    backendDOMNodeId: number,
    expectedText: string,
    lease: RuntimeLease,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.guardExpectedLease(lease, signal);
    await super.clickExistingTurnSendButton(
      conversationLocator,
      backendDOMNodeId,
      expectedText,
      lease,
      signal,
    );
  }

  public override async createProjectThroughUi(
    name: ProjectName,
    lease: RuntimeLease,
    signal?: AbortSignal,
    onMutationAttempted?: () => void,
  ): Promise<ProjectLocator> {
    await this.guardExpectedLease(lease, signal);
    return await super.createProjectThroughUi(name, lease, signal, onMutationAttempted);
  }

  private requireImmutableLease(): RuntimeLease {
    if (this.immutableLease === null) {
      throw new RuntimeGenerationChangedError();
    }
    return this.immutableLease;
  }

  private async guardCurrent(signal?: AbortSignal): Promise<void> {
    await assertGuardCurrent(this.provenanceGuard, this.requireImmutableLease(), signal);
  }

  private async guardBeforeMutation(signal?: AbortSignal): Promise<void> {
    await this.guardCurrent(signal);
  }

  private async guardExpectedLease(lease: RuntimeLease, signal?: AbortSignal): Promise<void> {
    const expected = this.requireImmutableLease();
    if (!sameRuntimeLease(expected, lease)) {
      throw new RuntimeGenerationChangedError();
    }
    await assertGuardCurrent(this.provenanceGuard, expected, signal);
  }
}
