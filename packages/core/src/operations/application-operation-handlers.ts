import { GitService } from "@diffdash/local-git/local-git"
import { GitFileRevision } from "@diffdash/domain/git-provider"
import { AppState } from "@diffdash/settings/app-state"
import { Effect, Option } from "effect"

import { CoreExternalFileOpenIntent, CoreLocalFileOpenIntent, CoreMethod } from "../core-contract"
import { CoreAbsolutePath, CoreWebUrl } from "../core-configuration"
import { AgentProviders } from "../services/agent-providers"
import { GitProvider } from "../services/git-provider"
import { Prerequisites } from "../services/prerequisites"
import { RepositoryLinker } from "../services/repository-linker"
import type { OperationHandlersFor } from "./operation-handlers"

type ApplicationMethod =
  | typeof CoreMethod.agentProvidersGetCatalog
  | typeof CoreMethod.appDiagnostics
  | typeof CoreMethod.appInstallDiffDashCli
  | typeof CoreMethod.appOpenLocalRepositoryFile
  | typeof CoreMethod.appOpenRepositoryComparisonFile
  | typeof CoreMethod.appOpenRepositoryFile
  | typeof CoreMethod.appStateGet
  | typeof CoreMethod.appStateUpdate

/** Acquires application-shell and native file-navigation handlers. */
export const makeApplicationOperationHandlers: Effect.Effect<
  OperationHandlersFor<ApplicationMethod>,
  never,
  AgentProviders | AppState | GitProvider | GitService | Prerequisites | RepositoryLinker
> = Effect.gen(function* () {
  const agentProviders = yield* AgentProviders
  const appState = yield* AppState
  const gitProvider = yield* GitProvider
  const git = yield* GitService
  const prerequisites = yield* Prerequisites
  const repositories = yield* RepositoryLinker

  return {
    [CoreMethod.agentProvidersGetCatalog]: () => agentProviders.catalog,
    [CoreMethod.appDiagnostics]: () => prerequisites.get,
    [CoreMethod.appInstallDiffDashCli]: () => prerequisites.installDiffDashCli,
    [CoreMethod.appOpenLocalRepositoryFile]: ({ rootPath, filePath }) =>
      git.detectRoot(rootPath).pipe(
        Effect.map((canonicalRootPath) =>
          CoreLocalFileOpenIntent.make({
            rootPath: CoreAbsolutePath.make(canonicalRootPath),
            filePath,
          }),
        ),
      ),
    [CoreMethod.appOpenRepositoryComparisonFile]: ({ target, filePath }) =>
      gitProvider
        .fileUrl(target.repository, filePath, GitFileRevision.make(target.headSha))
        .pipe(Effect.map((url) => CoreExternalFileOpenIntent.make({ url: CoreWebUrl.make(url) }))),
    [CoreMethod.appOpenRepositoryFile]: (request) =>
      Effect.gen(function* () {
        const linkedRepository = yield* repositories.findHosted(request.review.repository)
        if (Option.isSome(linkedRepository) && linkedRepository.value.localPath !== null) {
          const localPath = linkedRepository.value.localPath
          const currentBranch = yield* git.currentBranch(localPath).pipe(Effect.option)
          if (
            Option.isSome(currentBranch) &&
            String(currentBranch.value) === String(request.headRefName)
          ) {
            return CoreLocalFileOpenIntent.make({
              rootPath: CoreAbsolutePath.make(localPath),
              filePath: request.filePath,
            })
          }
        }
        const url = yield* gitProvider.fileUrl(
          request.review.repository,
          request.filePath,
          GitFileRevision.make(request.headRevision ?? request.headRefName),
        )
        return CoreExternalFileOpenIntent.make({ url: CoreWebUrl.make(url) })
      }),
    [CoreMethod.appStateGet]: () => appState.get,
    [CoreMethod.appStateUpdate]: ({ state }) => appState.save(state),
  } satisfies OperationHandlersFor<ApplicationMethod>
})
