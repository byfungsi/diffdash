import type { ProjectWorkspaceState } from "@diffdash/domain/project-workspace"
import { ProjectWorkspaceStore } from "@diffdash/persistence/project-workspace-store"
import { InvokeChannel } from "@diffdash/protocol/channels"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines persisted project workspace IPC handler implementations. */
export const defineProjectWorkspaceHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  const run = runtime.runPromise

  handlers.define(
    InvokeChannel.projectWorkspaceGet,
    async (_event, { projectId }): Promise<ProjectWorkspaceState | null> => {
      const workspace = await run(ProjectWorkspaceStore)
      return run(workspace.get(projectId))
    },
  )

  handlers.define(
    InvokeChannel.projectWorkspaceSave,
    async (_event, { input }): Promise<ProjectWorkspaceState> => {
      const workspace = await run(ProjectWorkspaceStore)
      return run(workspace.save(input))
    },
  )
}
