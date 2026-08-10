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
  handlers.defineCore(CoreMethod.listRepositories, runtime.execute)
  handlers.defineCore(CoreMethod.setRepositoryFavorite, runtime.execute)
  handlers.defineCore(CoreMethod.favoriteRemoteRepository, runtime.execute)
  handlers.defineCore(CoreMethod.installRepository, runtime.execute)
  handlers.defineCore(CoreMethod.linkRepository, runtime.execute)
  handlers.defineCore(CoreMethod.openProject, runtime.execute)
  handlers.defineCore(CoreMethod.repairRepositoryIdentities, runtime.execute)
  handlers.defineCore(CoreMethod.forgetRepository, runtime.execute)

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

  handlers.defineCore(CoreMethod.listProviders, runtime.execute)
  handlers.defineCore(CoreMethod.searchHostedRepositories, runtime.execute)
  handlers.defineCore(CoreMethod.listHostedRepositorySearchScopes, runtime.execute)
}
