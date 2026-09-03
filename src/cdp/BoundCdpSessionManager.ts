import { ControllerConfig } from "../config/ControllerConfig.js";
import { ProjectLocator, ProjectName } from "../domain/ProjectIdentity.js";
import { RuntimeLease, RuntimeLeaseSource, sameRuntimeLease } from "../domain/RuntimeGeneration.js";
import { ConversationLocator } from "../domain/ThreadIdentity.js";
import {
  OperationTimeoutError,
  RuntimeGenerationChangedError,
  RuntimeProvenanceUnverifiedError,
} from "../domain/errors.js";
import { RouteExpectation } from "../readiness/types.js";
import { RuntimeProvenanceGuard } from "../runtime/BoundRuntimeProvenanceGuard.js";
import { throwIfAborted, withTimeout } from "../utils/timeout.js";
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
import { CdpTargetInfo } from "./types.js";

const DEFAULT_BOUND_PROVENANCE_TIMEOUT_MS = 5000;

class GuardOperationTimeoutError extends Error {
  public constructor(public readonly timeout: OperationTimeoutError) {
    super(timeout.message);
    this.name = "GuardOperationTimeoutError";
  }
}

interface BoundCdpSessionManagerOptions extends CdpSessionManagerOptions {
  readonly provenanceTimeoutMs?: number;
}

class BoundedProvenanceOperations {
  public constructor(
    private readonly guard: RuntimeProvenanceGuard,
    private readonly timeoutMs: number,
  ) {}

  public async bind(lease: RuntimeLease, signal?: AbortSignal): Promise<void> {
    await this.run((operationSignal) => this.guard.bind(lease, operationSignal), signal);
  }

  public async assertCurrent(lease: RuntimeLease, signal?: AbortSignal): Promise<void> {
    await this.run((operationSignal) => this.guard.assertCurrent(lease, operationSignal), signal);
  }

  private async run(
    operation: (signal: AbortSignal) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await withTimeout(
        async (operationSignal) => {
          throwIfAborted(operationSignal);
          try {
            await operation(operationSignal);
          } catch (error) {
            if (error instanceof OperationTimeoutError && !operationSignal.aborted) {
              throw new GuardOperationTimeoutError(error);
            }
            throw error;
          }
          throwIfAborted(operationSignal);
        },
        this.timeoutMs,
        signal
          ? { signal, message: "Timed out verifying bound runtime provenance." }
          : { message: "Timed out verifying bound runtime provenance." },
      );
    } catch (error) {
      if (error instanceof GuardOperationTimeoutError) {
        throw error.timeout;
      }
      if (error instanceof OperationTimeoutError) {
        throw new RuntimeProvenanceUnverifiedError(undefined, { cause: error });
      }
      throw error;
    }
  }
}

class GuardedDiscovery implements CdpTargetDiscoveryLike {
  public constructor(
    private readonly inner: CdpTargetDiscoveryLike,
    private readonly config: ControllerConfig,
    private readonly getLease: () => RuntimeLease,
    private readonly provenance: BoundedProvenanceOperations,
  ) {}

  public async findPrimaryTarget(options: FindPrimaryTargetOptions = {}) {
    const lease = this.getLease();
    await this.provenance.assertCurrent(lease, options.signal);
    const target = await this.inner.findPrimaryTarget(options);
    assertTargetDebuggerEndpoint(target, this.config);
    await this.provenance.assertCurrent(lease, options.signal);
    return target;
  }
}

class GuardedTransport implements CdpTransport {
  public constructor(
    private readonly inner: CdpTransport,
    private readonly getLease: () => RuntimeLease,
    private readonly provenance: BoundedProvenanceOperations,
  ) {}

  public async connect(options: CdpTransportConnectOptions): Promise<CdpTransportSession> {
    const lease = this.getLease();
    return await this.inner.connect({
      ...options,
      beforeMutation: async (mutationSignal) => {
        await this.provenance.assertCurrent(lease, mutationSignal);
      },
    });
  }
}

export class BoundCdpSessionManager extends CdpSessionManager {
  public readonly boundMutationCancellation = true as const;
  private immutableLease: RuntimeLease | null = null;
  private readonly provenance: BoundedProvenanceOperations;

  public constructor(
    config: ControllerConfig,
    runtime: RuntimeLeaseSource,
    provenanceGuard: RuntimeProvenanceGuard,
    options: BoundCdpSessionManagerOptions = {},
  ) {
    const {
      provenanceTimeoutMs = DEFAULT_BOUND_PROVENANCE_TIMEOUT_MS,
      ...baseOptions
    } = options;
    const provenance = new BoundedProvenanceOperations(provenanceGuard, provenanceTimeoutMs);
    let getLease: () => RuntimeLease = () => {
      throw new RuntimeGenerationChangedError();
    };
    const discovery = new GuardedDiscovery(
      baseOptions.discovery ?? new CdpTargetDiscovery(config),
      config,
      () => getLease(),
      provenance,
    );
    const transport = new GuardedTransport(
      baseOptions.transport ?? new ChromeRemoteInterfaceTransport(),
      () => getLease(),
      provenance,
    );
    super(config, runtime, { ...baseOptions, discovery, transport });
    this.provenance = provenance;
    getLease = () => this.requireImmutableLease();
  }

  protected override rawMutationSignal(signal?: AbortSignal): AbortSignal | undefined {
    return signal;
  }

  protected override async attachTransport(
    target: CdpTargetInfo,
    signal?: AbortSignal,
  ): Promise<CdpTransportSession> {
    const lease = this.requireImmutableLease();
    await this.provenance.assertCurrent(lease, signal);
    const session = await super.attachTransport(target, signal);
    try {
      await this.provenance.assertCurrent(lease, signal);
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  protected override async initializeReadinessObservation(
    session: CdpTransportSession,
    signal?: AbortSignal,
  ): Promise<void> {
    const lease = this.requireImmutableLease();
    await this.provenance.assertCurrent(lease, signal);
    await super.initializeReadinessObservation(session, signal);
    await this.provenance.assertCurrent(lease, signal);
  }

  public async bindExistingRuntime(lease: RuntimeLease, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.immutableLease === null) {
      this.immutableLease = lease;
      await this.provenance.bind(lease, signal);
      throwIfAborted(signal);
    } else if (!sameRuntimeLease(this.immutableLease, lease)) {
      throw new RuntimeGenerationChangedError();
    }
    await this.connect(signal);
  }

  public override async connect(signal?: AbortSignal): Promise<void> {
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
    await this.provenance.assertCurrent(this.requireImmutableLease(), signal);
  }

  private async guardBeforeMutation(signal?: AbortSignal): Promise<void> {
    await this.guardCurrent(signal);
  }

  private async guardExpectedLease(lease: RuntimeLease, signal?: AbortSignal): Promise<void> {
    const expected = this.requireImmutableLease();
    if (!sameRuntimeLease(expected, lease)) {
      throw new RuntimeGenerationChangedError();
    }
    await this.provenance.assertCurrent(expected, signal);
  }
}
