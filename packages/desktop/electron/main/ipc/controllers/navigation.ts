import { GitService } from "@diffdash/local-git/local-git"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { InvokeChannel } from "@diffdash/protocol/channels"
import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import { shell } from "electron"
import { isAbsolute } from "node:path"
import { GitProvider } from "../../../../src/main/services/git-provider"
import type { ApplicationRuntime } from "../../application-runtime"
import { normalizeReviewFilePath, resolveContainedRepositoryPath } from "../../electron-policy"
import { openAllowedExternalUrl, openLocalPath, openProviderFile } from "../../file-opening"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines navigation IPC handler implementations. */
export const defineNavigationHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
  navigationCommands: { readonly drain: () => readonly CliNavigationCommand[] },
) => {
  const run = runtime.runPromise

  handlers.define(
    InvokeChannel.drainNavigationCommands,
    async (): Promise<readonly CliNavigationCommand[]> => {
      return navigationCommands.drain()
    },
  )

  handlers.define(InvokeChannel.appOpenExternalUrl, async (_event, { url }): Promise<void> => {
    await openAllowedExternalUrl((targetUrl) => shell.openExternal(targetUrl), url)
  })

  handlers.define(InvokeChannel.appOpenRepositoryFile, async (_event, request): Promise<void> => {
    const hostedRepository = request.review.repository
    const store = await run(RepositoryStore)
    const git = await run(GitService)
    const gitProvider = await run(GitProvider)
    const repositories = await run(
      store.list(`${hostedRepository.namespace}/${hostedRepository.name}`),
    )
    const linkedRepository = repositories.find(
      (repo) =>
        repo.provider === request.review.repository.providerId &&
        repo.owner.toLowerCase() === request.review.repository.namespace.toLowerCase() &&
        repo.name.toLowerCase() === request.review.repository.name.toLowerCase(),
    )

    if (isAbsolute(request.filePath)) {
      throw new Error("Cannot open an absolute file path from a review")
    }

    const normalizedFilePath = normalizeReviewFilePath(request.filePath)

    if (linkedRepository?.localPath === null || linkedRepository?.localPath === undefined) {
      await openProviderFile(
        (locator, path, revision) => run(gitProvider.fileUrl(locator, path, revision)),
        (targetUrl) => shell.openExternal(targetUrl),
        request.review.repository,
        normalizedFilePath,
        request.headRefName,
        request.headRevision,
      )
      return
    }

    let currentBranch: string
    try {
      currentBranch = await run(git.currentBranch(linkedRepository.localPath))
    } catch {
      await openProviderFile(
        (locator, path, revision) => run(gitProvider.fileUrl(locator, path, revision)),
        (targetUrl) => shell.openExternal(targetUrl),
        request.review.repository,
        normalizedFilePath,
        request.headRefName,
        request.headRevision,
      )
      return
    }
    if (currentBranch !== request.headRefName) {
      await openProviderFile(
        (locator, path, revision) => run(gitProvider.fileUrl(locator, path, revision)),
        (targetUrl) => shell.openExternal(targetUrl),
        request.review.repository,
        normalizedFilePath,
        request.headRefName,
        request.headRevision,
      )
      return
    }

    const targetPath = resolveContainedRepositoryPath(
      linkedRepository.localPath,
      normalizedFilePath,
    )

    await openLocalPath((path) => shell.openPath(path), targetPath)
  })

  handlers.define(
    InvokeChannel.appOpenLocalRepositoryFile,
    async (_event, { rootPath, filePath }): Promise<void> => {
      const git = await run(GitService)
      const canonicalRootPath = await run(git.detectRoot(rootPath))

      const targetPath = resolveContainedRepositoryPath(canonicalRootPath, filePath)

      await openLocalPath((path) => shell.openPath(path), targetPath)
    },
  )
}

/** Registers navigation and shell handlers with Electron. */
export const installNavigationController = (registry: IpcControllerRegistry) =>
  registry.install([
    InvokeChannel.drainNavigationCommands,
    InvokeChannel.appOpenExternalUrl,
    InvokeChannel.appOpenRepositoryFile,
    InvokeChannel.appOpenLocalRepositoryFile,
  ])
