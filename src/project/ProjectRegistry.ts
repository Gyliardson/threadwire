import { randomUUID } from "node:crypto";
import {
  ProjectHandle,
  ProjectLocator,
  createOpaqueProjectHandle,
  createProjectLocator,
} from "../domain/ProjectIdentity.js";
import { ProjectHandleCollisionError } from "../domain/errors.js";

const MAX_PROJECT_HANDLE_COLLISION_ATTEMPTS = 8;

export interface ProjectRegistryOptions {
  readonly handleFactory?: () => string;
}

export class ProjectRegistry {
  private readonly projects = new Map<ProjectHandle, ProjectLocator>();
  private readonly handlesByLocator = new Map<ProjectLocator, ProjectHandle>();
  private readonly handleFactory: () => string;

  public constructor(options: ProjectRegistryOptions = {}) {
    this.handleFactory = options.handleFactory ?? randomUUID;
  }

  public register(locator: ProjectLocator): ProjectHandle {
    const validatedLocator = createProjectLocator(locator);
    const existingHandle = this.handlesByLocator.get(validatedLocator);
    if (existingHandle !== undefined) {
      return existingHandle;
    }

    for (let attempt = 0; attempt < MAX_PROJECT_HANDLE_COLLISION_ATTEMPTS; attempt += 1) {
      const handle = createOpaqueProjectHandle(this.handleFactory());
      if (this.projects.has(handle)) {
        continue;
      }
      this.projects.set(handle, validatedLocator);
      this.handlesByLocator.set(validatedLocator, handle);
      return handle;
    }
    throw new ProjectHandleCollisionError();
  }
}
