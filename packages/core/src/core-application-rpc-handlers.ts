import { CoreApplicationFailureCode, CoreApplicationRpcs } from "@diffdash/core-rpc/application-rpc"
import { Effect } from "effect"

import type { HostRequestContext } from "@diffdash/core-rpc/identity"
import type { CoreMethod as CoreMethodType, CoreMethodInput } from "./core-contract"
import { CoreRuntimeServices } from "./core-runtime-services"

type ApplicationRpcRequest<Method extends CoreMethodType> = HostRequestContext &
  CoreMethodInput<Method>

/** Native per-method handlers backed by the installed Core operation authority. */
export const coreApplicationRpcHandlersLayer = CoreApplicationRpcs.toLayer(
  Effect.gen(function* () {
    const runtime = yield* CoreRuntimeServices
    const execute = <Method extends CoreMethodType>(
      method: Method,
      request: ApplicationRpcRequest<Method>,
    ) =>
      runtime.operations.pipe(
        Effect.flatMap((operations) => {
          return operations.execute(method, request)
        }),
        Effect.mapError(() => ({
          _tag: "CoreApplicationFailure" as const,
          applicationInstanceId: request.applicationInstanceId,
          processEpoch: request.processEpoch,
          requestId: request.requestId,
          method,
          code: CoreApplicationFailureCode.make("APPLICATION_OPERATION_FAILED"),
          retryClass: "userAction" as const,
          safeMessage: "DiffDash Core could not complete this application operation.",
        })),
      )

    const handlers = {
      "Analytics.capture": (request: ApplicationRpcRequest<"Analytics.capture">) =>
        execute("Analytics.capture", request),
      "Analytics.start": (request: ApplicationRpcRequest<"Analytics.start">) =>
        execute("Analytics.start", request),
      "AgentProviders.getCatalog": (request: ApplicationRpcRequest<"AgentProviders.getCatalog">) =>
        execute("AgentProviders.getCatalog", request),
      "Prerequisites.get": (request: ApplicationRpcRequest<"Prerequisites.get">) =>
        execute("Prerequisites.get", request),
      "Prerequisites.installDiffDashCli": (
        request: ApplicationRpcRequest<"Prerequisites.installDiffDashCli">,
      ) => execute("Prerequisites.installDiffDashCli", request),
      "FileNavigation.resolveLocalRepositoryFile": (
        request: ApplicationRpcRequest<"FileNavigation.resolveLocalRepositoryFile">,
      ) => execute("FileNavigation.resolveLocalRepositoryFile", request),
      "FileNavigation.resolveRepositoryComparisonFile": (
        request: ApplicationRpcRequest<"FileNavigation.resolveRepositoryComparisonFile">,
      ) => execute("FileNavigation.resolveRepositoryComparisonFile", request),
      "FileNavigation.resolveHostedReviewFile": (
        request: ApplicationRpcRequest<"FileNavigation.resolveHostedReviewFile">,
      ) => execute("FileNavigation.resolveHostedReviewFile", request),
      "GitProviders.list": (request: ApplicationRpcRequest<"GitProviders.list">) =>
        execute("GitProviders.list", request),
      "HostedReviews.submitDecision": (
        request: ApplicationRpcRequest<"HostedReviews.submitDecision">,
      ) => execute("HostedReviews.submitDecision", request),
      "HostedReviews.getDecision": (request: ApplicationRpcRequest<"HostedReviews.getDecision">) =>
        execute("HostedReviews.getDecision", request),
      "HostedReviews.list": (request: ApplicationRpcRequest<"HostedReviews.list">) =>
        execute("HostedReviews.list", request),
      "HostedReviews.listAssigned": (
        request: ApplicationRpcRequest<"HostedReviews.listAssigned">,
      ) => execute("HostedReviews.listAssigned", request),
      "GitProviders.listSearchScopes": (
        request: ApplicationRpcRequest<"GitProviders.listSearchScopes">,
      ) => execute("GitProviders.listSearchScopes", request),
      "GitProviders.searchRepositories": (
        request: ApplicationRpcRequest<"GitProviders.searchRepositories">,
      ) => execute("GitProviders.searchRepositories", request),
      "LocalReviews.resolveBranch": (
        request: ApplicationRpcRequest<"LocalReviews.resolveBranch">,
      ) => execute("LocalReviews.resolveBranch", request),
      "LocalReviews.resolveLastCommit": (
        request: ApplicationRpcRequest<"LocalReviews.resolveLastCommit">,
      ) => execute("LocalReviews.resolveLastCommit", request),
      "RepositoryComparisons.resolve": (
        request: ApplicationRpcRequest<"RepositoryComparisons.resolve">,
      ) => execute("RepositoryComparisons.resolve", request),
      "ReviewSnapshots.acquireHosted": (
        request: ApplicationRpcRequest<"ReviewSnapshots.acquireHosted">,
      ) => execute("ReviewSnapshots.acquireHosted", request),
      "ReviewSnapshots.acquireLocal": (
        request: ApplicationRpcRequest<"ReviewSnapshots.acquireLocal">,
      ) => execute("ReviewSnapshots.acquireLocal", request),
      "ReviewSnapshots.acquireRepositoryComparison": (
        request: ApplicationRpcRequest<"ReviewSnapshots.acquireRepositoryComparison">,
      ) => execute("ReviewSnapshots.acquireRepositoryComparison", request),
      "Repositories.favoriteRemote": (
        request: ApplicationRpcRequest<"Repositories.favoriteRemote">,
      ) => execute("Repositories.favoriteRemote", request),
      "Repositories.forget": (request: ApplicationRpcRequest<"Repositories.forget">) =>
        execute("Repositories.forget", request),
      "Repositories.install": (request: ApplicationRpcRequest<"Repositories.install">) =>
        execute("Repositories.install", request),
      "Repositories.link": (request: ApplicationRpcRequest<"Repositories.link">) =>
        execute("Repositories.link", request),
      "Repositories.list": (request: ApplicationRpcRequest<"Repositories.list">) =>
        execute("Repositories.list", request),
      "Repositories.openProject": (request: ApplicationRpcRequest<"Repositories.openProject">) =>
        execute("Repositories.openProject", request),
      "Repositories.repairIdentities": (
        request: ApplicationRpcRequest<"Repositories.repairIdentities">,
      ) => execute("Repositories.repairIdentities", request),
      "Repositories.setFavorite": (request: ApplicationRpcRequest<"Repositories.setFavorite">) =>
        execute("Repositories.setFavorite", request),
      "ProjectWorkspace.get": (request: ApplicationRpcRequest<"ProjectWorkspace.get">) =>
        execute("ProjectWorkspace.get", request),
      "ProjectWorkspace.save": (request: ApplicationRpcRequest<"ProjectWorkspace.save">) =>
        execute("ProjectWorkspace.save", request),
      "ReviewThreads.addUserMessage": (
        request: ApplicationRpcRequest<"ReviewThreads.addUserMessage">,
      ) => execute("ReviewThreads.addUserMessage", request),
      "ReviewThreads.create": (request: ApplicationRpcRequest<"ReviewThreads.create">) =>
        execute("ReviewThreads.create", request),
      "ReviewThreads.get": (request: ApplicationRpcRequest<"ReviewThreads.get">) =>
        execute("ReviewThreads.get", request),
      "ReviewThreads.list": (request: ApplicationRpcRequest<"ReviewThreads.list">) =>
        execute("ReviewThreads.list", request),
      "Settings.get": (request: ApplicationRpcRequest<"Settings.get">) =>
        execute("Settings.get", request),
      "Settings.update": (request: ApplicationRpcRequest<"Settings.update">) =>
        execute("Settings.update", request),
      "ViewedFiles.listHosted": (request: ApplicationRpcRequest<"ViewedFiles.listHosted">) =>
        execute("ViewedFiles.listHosted", request),
      "ViewedFiles.listLocal": (request: ApplicationRpcRequest<"ViewedFiles.listLocal">) =>
        execute("ViewedFiles.listLocal", request),
      "ViewedFiles.setHosted": (request: ApplicationRpcRequest<"ViewedFiles.setHosted">) =>
        execute("ViewedFiles.setHosted", request),
      "ViewedFiles.setLocal": (request: ApplicationRpcRequest<"ViewedFiles.setLocal">) =>
        execute("ViewedFiles.setLocal", request),
      "ViewedFiles.listRepositoryComparison": (
        request: ApplicationRpcRequest<"ViewedFiles.listRepositoryComparison">,
      ) => execute("ViewedFiles.listRepositoryComparison", request),
      "ViewedFiles.setRepositoryComparison": (
        request: ApplicationRpcRequest<"ViewedFiles.setRepositoryComparison">,
      ) => execute("ViewedFiles.setRepositoryComparison", request),
    }

    return handlers
  }),
)
