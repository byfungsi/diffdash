import type { Repo, RepositorySearchScope } from "@diffdash/domain/repository"
import { RepositorySearchRequest, RepositorySearchResult } from "@diffdash/domain/repository"
import { GitService } from "@diffdash/local-git/local-git"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { CliError } from "@diffdash/process/cli"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { HostedProviderRequest, HostedRepositorySearchRequest } from "@diffdash/protocol/hosted-git"
import { LinkRepositoryCheckoutRequest } from "@diffdash/protocol/repository-link"
import { Schema } from "effect"
import { dialog } from "electron"
import { GitProvider } from "../../../../src/main/services/git-provider"
import {
  RepositoryLinker,
  RepositoryLinkError,
} from "../../../../src/main/services/repository-linker"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"
import { localRepositoryInput } from "./helpers"

/** Defines repositories IPC handler implementations. */
export const defineRepositoryHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
) => {
  const run = runtime.runPromise

  handlers.define(
    InvokeChannel.listRepositories,
    async (_event, query?: string): Promise<readonly Repo[]> => {
      const store = await run(RepositoryStore)
      return run(store.list(query))
    },
  )

  handlers.define(
    InvokeChannel.setRepositoryFavorite,
    async (_event, id: string, isFavorite: boolean): Promise<Repo> => {
      const store = await run(RepositoryStore)
      return run(store.setFavorite(id, isFavorite))
    },
  )

  handlers.define(
    InvokeChannel.favoriteRemoteRepository,
    async (_event, input: unknown): Promise<Repo> => {
      const repo = await run(Schema.decodeUnknown(RepositorySearchResult)(input))
      const store = await run(RepositoryStore)
      return run(
        store.upsertRepository({
          provider: repo.providerId,
          owner: repo.owner,
          name: repo.name,
          remoteUrl: repo.url,
          localPath: null,
          isFavorite: true,
        }),
      )
    },
  )

  handlers.define(
    InvokeChannel.addLocalRepository,
    async (_event, localPath: string): Promise<Repo> => {
      const git = await run(GitService)
      const gitProvider = await run(GitProvider)
      const store = await run(RepositoryStore)
      const rootPath = await run(git.detectRoot(localPath))
      try {
        const checkout = await run(git.detectRepository(rootPath))
        const detected = await run(gitProvider.parseRemoteUrl(checkout.remoteUrl))
        return run(
          store.upsertRepository({
            provider: detected.providerId,
            owner: detected.namespace,
            name: detected.name,
            remoteUrl: checkout.remoteUrl,
            localPath: checkout.rootPath,
            isFavorite: true,
          }),
        )
      } catch {
        return run(store.upsertRepository(localRepositoryInput(rootPath)))
      }
    },
  )

  handlers.define(
    InvokeChannel.installRepository,
    async (_event, localPath: string): Promise<Repo> => {
      const linker = await run(RepositoryLinker)
      try {
        return await run(linker.install(localPath))
      } catch (error) {
        if (error instanceof RepositoryLinkError) throw new Error(error.reason, { cause: error })
        throw error
      }
    },
  )

  handlers.define(InvokeChannel.linkRepository, async (_event, input: unknown): Promise<Repo> => {
    const request = await run(Schema.decodeUnknown(LinkRepositoryCheckoutRequest)(input))
    const linker = await run(RepositoryLinker)
    try {
      return await run(linker.link(request))
    } catch (error) {
      if (error instanceof RepositoryLinkError) throw new Error(error.reason, { cause: error })
      throw error
    }
  })

  handlers.define(InvokeChannel.selectLocalFolder, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Select a local Git repository",
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handlers.define(
    InvokeChannel.listProviders,
    async (): Promise<readonly import("@diffdash/domain/git-provider").GitProviderDescriptor[]> => {
      const gitProvider = await run(GitProvider)
      return run(gitProvider.listProviders)
    },
  )

  handlers.define(
    InvokeChannel.searchHostedRepositories,
    async (_event, input: unknown): Promise<readonly RepositorySearchResult[]> => {
      const request = await run(Schema.decodeUnknown(HostedRepositorySearchRequest)(input))
      const gitProvider = await run(GitProvider)
      try {
        return await run(
          gitProvider.searchRepositories(
            RepositorySearchRequest.make({
              providerId: request.providerId,
              query: request.query,
              owners: request.namespaces,
            }),
          ),
        )
      } catch (error) {
        if (error instanceof CliError) {
          const detail = error.stderr.trim() || error.stdout?.trim()
          throw new Error(detail || "GitHub repository search failed.", { cause: error })
        }
        throw error
      }
    },
  )

  handlers.define(
    InvokeChannel.listHostedRepositorySearchScopes,
    async (_event, input: unknown): Promise<readonly RepositorySearchScope[]> => {
      const request = await run(Schema.decodeUnknown(HostedProviderRequest)(input))
      const gitProvider = await run(GitProvider)
      return run(gitProvider.listSearchScopes(request.providerId))
    },
  )
}

/** Registers repository handlers with Electron. */
export const installRepositoriesController = (registry: IpcControllerRegistry) =>
  registry.install([
    InvokeChannel.listRepositories,
    InvokeChannel.setRepositoryFavorite,
    InvokeChannel.favoriteRemoteRepository,
    InvokeChannel.addLocalRepository,
    InvokeChannel.installRepository,
    InvokeChannel.linkRepository,
    InvokeChannel.selectLocalFolder,
    InvokeChannel.listProviders,
    InvokeChannel.searchHostedRepositories,
    InvokeChannel.listHostedRepositorySearchScopes,
  ])
