import { CoreMethod } from "@diffdash/core"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { InvokeContract } from "@diffdash/protocol/ipc"
import { Schema } from "effect"
import { dialog } from "electron"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines repositories IPC handler implementations. */
export const defineRepositoryHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  handlers.defineCore(CoreMethod.listRepositories, runtime.core.listRepositories)
  handlers.defineCore(CoreMethod.setRepositoryFavorite, runtime.core.setRepositoryFavorite)
  handlers.defineCore(CoreMethod.favoriteRemoteRepository, runtime.core.favoriteRemoteRepository)
  handlers.defineCore(CoreMethod.installRepository, runtime.core.installRepository)
  handlers.defineCore(CoreMethod.linkRepository, runtime.core.linkRepository)
  handlers.defineCore(CoreMethod.openProject, runtime.core.openProject)
  handlers.defineCore(
    CoreMethod.repairRepositoryIdentities,
    runtime.core.repairRepositoryIdentities,
  )
  handlers.defineCore(CoreMethod.forgetRepository, runtime.core.forgetRepository)

  handlers.define(InvokeChannel.selectLocalFolder, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Select a local Git repository",
    })
    const selectedPath = result.filePaths[0]
    return result.canceled || selectedPath === undefined
      ? null
      : Schema.decodeUnknownSync(InvokeContract[InvokeChannel.selectLocalFolder].response)(
          selectedPath,
        )
  })

  handlers.defineCore(CoreMethod.listProviders, runtime.core.listProviders)
  handlers.defineCore(CoreMethod.searchHostedRepositories, runtime.core.searchHostedRepositories)
  handlers.defineCore(
    CoreMethod.listHostedRepositorySearchScopes,
    runtime.core.listHostedRepositorySearchScopes,
  )
}
