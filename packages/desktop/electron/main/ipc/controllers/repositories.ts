import { CoreMethod } from "@diffdash/core"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { dialog } from "electron"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines repositories IPC handler implementations. */
export const defineRepositoryHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  handlers.define(InvokeChannel.listRepositories, async (_event, request) =>
    runtime.execute(CoreMethod.listRepositories, request),
  )
  handlers.define(InvokeChannel.setRepositoryFavorite, async (_event, request) =>
    runtime.execute(CoreMethod.setRepositoryFavorite, request),
  )
  handlers.define(InvokeChannel.favoriteRemoteRepository, async (_event, request) =>
    runtime.execute(CoreMethod.favoriteRemoteRepository, request),
  )
  handlers.define(InvokeChannel.installRepository, async (_event, request) =>
    runtime.execute(CoreMethod.installRepository, request),
  )
  handlers.define(InvokeChannel.linkRepository, async (_event, request) =>
    runtime.execute(CoreMethod.linkRepository, request),
  )
  handlers.define(InvokeChannel.openProject, async (_event, request) =>
    runtime.execute(CoreMethod.openProject, request),
  )
  handlers.define(InvokeChannel.repairRepositoryIdentities, async () =>
    runtime.execute(CoreMethod.repairRepositoryIdentities, {}),
  )
  handlers.define(InvokeChannel.forgetRepository, async (_event, request) =>
    runtime.execute(CoreMethod.forgetRepository, request),
  )

  handlers.define(InvokeChannel.selectLocalFolder, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Select a local Git repository",
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handlers.define(InvokeChannel.listProviders, async () =>
    runtime.execute(CoreMethod.listProviders, {}),
  )
  handlers.define(InvokeChannel.searchHostedRepositories, async (_event, request) =>
    runtime.execute(CoreMethod.searchHostedRepositories, request),
  )
  handlers.define(InvokeChannel.listHostedRepositorySearchScopes, async (_event, request) =>
    runtime.execute(CoreMethod.listHostedRepositorySearchScopes, request),
  )
}
