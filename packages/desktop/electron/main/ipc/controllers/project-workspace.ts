import { CoreMethod } from "@diffdash/core"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines persisted project workspace IPC handler implementations. */
export const defineProjectWorkspaceHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  handlers.defineCore(CoreMethod.projectWorkspaceGet, runtime.core.projectWorkspaceGet)
  handlers.defineCore(CoreMethod.projectWorkspaceSave, runtime.core.projectWorkspaceSave)
}
