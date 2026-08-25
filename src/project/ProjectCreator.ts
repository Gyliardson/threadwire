import {
  ProjectHandle,
  ProjectLocator,
  ProjectName,
  createProjectName,
} from "../domain/ProjectIdentity.js";
import { RuntimeLease } from "../domain/RuntimeGeneration.js";
import {
  OperationAbortedError,
  RuntimeGenerationChangedError,
  ProjectCreationFailedError,
} from "../domain/errors.js";
import { OperationScheduler } from "../routing/OperationScheduler.js";
import { withTimeout } from "../utils/timeout.js";
import { ProjectRegistry } from "./ProjectRegistry.js";

export const DEFAULT_PROJECT_CREATION_TIMEOUT_MS = 30_000;

export interface ProjectUiPort {
  createProjectThroughUi(
    name: ProjectName,
    lease: RuntimeLease,
    signal?: AbortSignal,
    onMutationAttempted?: () => void,
  ): Promise<ProjectLocator>;
}

export type ProjectCreationResult = Readonly<{ projectHandle: ProjectHandle }>;

export interface ProjectCreatorOptions {
  readonly timeoutMs?: number;
}

export class ProjectCreator {
  private readonly timeoutMs: number;

  public constructor(
    private readonly registry: ProjectRegistry,
    private readonly scheduler: OperationScheduler,
    private readonly ui: ProjectUiPort,
    options: ProjectCreatorOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROJECT_CREATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive safe integer.");
    }
  }

  public async create(name: string, signal?: AbortSignal): Promise<ProjectCreationResult> {
    const validatedName = createProjectName(name);
    return await this.scheduler.schedule(
      "PROJECT",
      async (operationSignal, lease) => {
        let mutationAttempted = false;
        try {
          const locator = await withTimeout(
            async (deadlineSignal) =>
              await this.ui.createProjectThroughUi(
                validatedName,
                lease,
                deadlineSignal,
                () => { mutationAttempted = true; },
              ),
            this.timeoutMs,
            operationSignal
              ? { signal: operationSignal, message: "Project creation timed out." }
              : { message: "Project creation timed out." },
          );
          return Object.freeze({ projectHandle: this.registry.register(locator) });
        } catch (error) {
          if (mutationAttempted) {
            this.scheduler.markRuntimeMutationStateUncertain(lease);
          }
          if (error instanceof RuntimeGenerationChangedError || error instanceof OperationAbortedError) {
            throw error;
          }
          throw new ProjectCreationFailedError();
        }
      },
      signal ? { signal } : {},
    );
  }
}
