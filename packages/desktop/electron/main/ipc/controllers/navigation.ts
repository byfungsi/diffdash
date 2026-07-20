import { GitService } from "@diffdash/local-git/local-git"
import { InvokeChannel } from "@diffdash/protocol/channels"
import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import { transportError } from "@diffdash/protocol/transport-error"
import { shell } from "electron"
import { isAbsolute } from "node:path"
import { GitProvider } from "../../../../src/main/services/git-provider"
import { RepositoryLinker } from "../../../../src/main/services/repository-linker"
import type { ApplicationRuntime } from "../../application-runtime"
import { normalizeReviewFilePath, resolveContainedRepositoryPath } from "../../electron-policy"
import type { RendererSecurityPolicy } from "../../electron-policy"
import { openLocalPath, openProviderFile } from "../../file-opening"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines navigation IPC handler implementations. */
export const defineNavigationHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
  navigationCommands: {
    readonly peek: () => readonly CliNavigationCommand[]
    readonly acknowledge: (count: number) => void
  },
  rendererSecurityPolicy: RendererSecurityPolicy,
) => {
  const run = runtime.runPromise

  handlers.defineTransactional(InvokeChannel.drainNavigationCommands, async () => {
    const commands = navigationCommands.peek()
    return {
      response: commands,
      commit: () => navigationCommands.acknowledge(commands.length),
    }
  })

  handlers.define(InvokeChannel.appOpenExternalUrl, async (_event, { url }): Promise<void> => {
    await rendererSecurityPolicy.openExternalUrl(url)
  })

  handlers.define(InvokeChannel.appOpenRepositoryFile, async (_event, request): Promise<void> => {
    const hostedRepository = request.review.repository
    const git = await run(GitService)
    const gitProvider = await run(GitProvider)
    const repositories = await run(RepositoryLinker)
    const linkedRepository = await run(repositories.findHosted(hostedRepository))

    if (isAbsolute(request.filePath)) {
      throw transportError(
        "INVALID_REVIEW_FILE_PATH",
        "Cannot open an absolute file path from a review.",
      )
    }

    const normalizedFilePath = normalizeReviewFilePath(request.filePath)

    if (linkedRepository?.localPath === null || linkedRepository?.localPath === undefined) {
      await openProviderFile(
        (locator, path, revision) => run(gitProvider.fileUrl(locator, path, revision)),
        rendererSecurityPolicy.openExternalUrl,
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
        rendererSecurityPolicy.openExternalUrl,
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
        rendererSecurityPolicy.openExternalUrl,
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
