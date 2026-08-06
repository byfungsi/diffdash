import { CoreMethod } from "@diffdash/core"
import { InvokeChannel } from "@diffdash/protocol/channels"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines persisted project workspace IPC handler implementations. */
export const defineProjectWorkspaceHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  handlers.define(InvokeChannel.projectWorkspaceGet, async (_event, request) =>
    runtime.execute(CoreMethod.projectWorkspaceGet, request),
  )

  handlers.define(InvokeChannel.projectWorkspaceSave, async (_event, request) =>
    runtime.execute(CoreMethod.projectWorkspaceSave, request),
  )
}
