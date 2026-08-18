import { CoreApplicationFailureCode, CoreApplicationRpcs } from "@diffdash/core-rpc/application-rpc"
import { Effect } from "effect"

import type { HostRequestContext } from "@diffdash/core-rpc/identity"
import type {
  CoreMethod as CoreMethodType,
  CoreMethodInput,
  CoreOperationFailure,
  CoreOperationOutput,
} from "./core-contract"
import { CoreRuntimeServices } from "./core-runtime-services"
import type { OperationHandlers } from "./operations/operation-handlers"

type ApplicationRpcRequest<Method extends CoreMethodType> = HostRequestContext &
  CoreMethodInput<Method>

/** Native per-method handlers backed by the installed Core operation authority. */
export const coreApplicationRpcHandlersLayer = CoreApplicationRpcs.toLayer(
  Effect.gen(function* () {
    const runtime = yield* CoreRuntimeServices
    const handle = <Method extends CoreMethodType>(
      method: Method,
      request: ApplicationRpcRequest<Method>,
      invoke: (
        methods: OperationHandlers,
      ) => Effect.Effect<CoreOperationOutput<Method>, CoreOperationFailure<Method>>,
    ) =>
      runtime.operations.pipe(
        Effect.flatMap((operations) => invoke(operations.methods)),
        Effect.tapError((cause) =>
          Effect.sync(() => console.error(`[DEBUG-dev-review] ${method}`, cause)),
        ),
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
        handle("Analytics.capture", request, (methods) =>
          methods["Analytics.capture"](request, {}),
        ),
      "Analytics.start": (request: ApplicationRpcRequest<"Analytics.start">) =>
        handle("Analytics.start", request, (methods) => methods["Analytics.start"](request, {})),
      "AgentProviders.getCatalog": (request: ApplicationRpcRequest<"AgentProviders.getCatalog">) =>
        handle("AgentProviders.getCatalog", request, (methods) =>
          methods["AgentProviders.getCatalog"](request, {}),
        ),
      "Prerequisites.get": (request: ApplicationRpcRequest<"Prerequisites.get">) =>
        handle("Prerequisites.get", request, (methods) =>
          methods["Prerequisites.get"](request, {}),
        ),
      "Prerequisites.installDiffDashCli": (
        request: ApplicationRpcRequest<"Prerequisites.installDiffDashCli">,
      ) =>
        handle("Prerequisites.installDiffDashCli", request, (methods) =>
          methods["Prerequisites.installDiffDashCli"](request, {}),
        ),
      "FileNavigation.resolveLocalRepositoryFile": (
        request: ApplicationRpcRequest<"FileNavigation.resolveLocalRepositoryFile">,
      ) =>
        handle("FileNavigation.resolveLocalRepositoryFile", request, (methods) =>
          methods["FileNavigation.resolveLocalRepositoryFile"](request, {}),
        ),
      "FileNavigation.resolveRepositoryComparisonFile": (
        request: ApplicationRpcRequest<"FileNavigation.resolveRepositoryComparisonFile">,
      ) =>
        handle("FileNavigation.resolveRepositoryComparisonFile", request, (methods) =>
          methods["FileNavigation.resolveRepositoryComparisonFile"](request, {}),
        ),
      "FileNavigation.resolveHostedReviewFile": (
        request: ApplicationRpcRequest<"FileNavigation.resolveHostedReviewFile">,
      ) =>
        handle("FileNavigation.resolveHostedReviewFile", request, (methods) =>
          methods["FileNavigation.resolveHostedReviewFile"](request, {}),
        ),
      "GitProviders.list": (request: ApplicationRpcRequest<"GitProviders.list">) =>
        handle("GitProviders.list", request, (methods) =>
          methods["GitProviders.list"](request, {}),
        ),
      "HostedReviews.submitDecision": (
        request: ApplicationRpcRequest<"HostedReviews.submitDecision">,
      ) =>
        handle("HostedReviews.submitDecision", request, (methods) =>
          methods["HostedReviews.submitDecision"](request, {}),
        ),
      "HostedReviews.getDecision": (request: ApplicationRpcRequest<"HostedReviews.getDecision">) =>
        handle("HostedReviews.getDecision", request, (methods) =>
          methods["HostedReviews.getDecision"](request, {}),
        ),
      "HostedReviews.list": (request: ApplicationRpcRequest<"HostedReviews.list">) =>
        handle("HostedReviews.list", request, (methods) =>
          methods["HostedReviews.list"](request, {}),
        ),
      "HostedReviews.listAssigned": (
        request: ApplicationRpcRequest<"HostedReviews.listAssigned">,
      ) =>
        handle("HostedReviews.listAssigned", request, (methods) =>
          methods["HostedReviews.listAssigned"](request, {}),
        ),
      "GitProviders.listSearchScopes": (
        request: ApplicationRpcRequest<"GitProviders.listSearchScopes">,
      ) =>
        handle("GitProviders.listSearchScopes", request, (methods) =>
          methods["GitProviders.listSearchScopes"](request, {}),
        ),
      "GitProviders.searchRepositories": (
        request: ApplicationRpcRequest<"GitProviders.searchRepositories">,
      ) =>
        handle("GitProviders.searchRepositories", request, (methods) =>
          methods["GitProviders.searchRepositories"](request, {}),
        ),
      "LocalReviews.resolveBranch": (
        request: ApplicationRpcRequest<"LocalReviews.resolveBranch">,
      ) =>
        handle("LocalReviews.resolveBranch", request, (methods) =>
          methods["LocalReviews.resolveBranch"](request, {}),
        ),
      "LocalReviews.resolveLastCommit": (
        request: ApplicationRpcRequest<"LocalReviews.resolveLastCommit">,
      ) =>
        handle("LocalReviews.resolveLastCommit", request, (methods) =>
          methods["LocalReviews.resolveLastCommit"](request, {}),
        ),
      "RepositoryComparisons.resolve": (
        request: ApplicationRpcRequest<"RepositoryComparisons.resolve">,
      ) =>
        handle("RepositoryComparisons.resolve", request, (methods) =>
          methods["RepositoryComparisons.resolve"](request, {}),
        ),
      "ReviewSnapshots.acquireHosted": (
        request: ApplicationRpcRequest<"ReviewSnapshots.acquireHosted">,
      ) =>
        handle("ReviewSnapshots.acquireHosted", request, (methods) =>
          methods["ReviewSnapshots.acquireHosted"](request, {}),
        ),
      "ReviewSnapshots.acquireLocal": (
        request: ApplicationRpcRequest<"ReviewSnapshots.acquireLocal">,
      ) =>
        handle("ReviewSnapshots.acquireLocal", request, (methods) =>
          methods["ReviewSnapshots.acquireLocal"](request, {}),
        ),
      "ReviewSnapshots.acquireRepositoryComparison": (
        request: ApplicationRpcRequest<"ReviewSnapshots.acquireRepositoryComparison">,
      ) =>
        handle("ReviewSnapshots.acquireRepositoryComparison", request, (methods) =>
          methods["ReviewSnapshots.acquireRepositoryComparison"](request, {}),
        ),
      "Repositories.favoriteRemote": (
        request: ApplicationRpcRequest<"Repositories.favoriteRemote">,
      ) =>
        handle("Repositories.favoriteRemote", request, (methods) =>
          methods["Repositories.favoriteRemote"](request, {}),
        ),
      "Repositories.forget": (request: ApplicationRpcRequest<"Repositories.forget">) =>
        handle("Repositories.forget", request, (methods) =>
          methods["Repositories.forget"](request, {}),
        ),
      "Repositories.install": (request: ApplicationRpcRequest<"Repositories.install">) =>
        handle("Repositories.install", request, (methods) =>
          methods["Repositories.install"](request, {}),
        ),
      "Repositories.link": (request: ApplicationRpcRequest<"Repositories.link">) =>
        handle("Repositories.link", request, (methods) =>
          methods["Repositories.link"](request, {}),
        ),
      "Repositories.list": (request: ApplicationRpcRequest<"Repositories.list">) =>
        handle("Repositories.list", request, (methods) =>
          methods["Repositories.list"](request, {}),
        ),
      "Repositories.openProject": (request: ApplicationRpcRequest<"Repositories.openProject">) =>
        handle("Repositories.openProject", request, (methods) =>
          methods["Repositories.openProject"](request, {}),
        ),
      "Repositories.repairIdentities": (
        request: ApplicationRpcRequest<"Repositories.repairIdentities">,
      ) =>
        handle("Repositories.repairIdentities", request, (methods) =>
          methods["Repositories.repairIdentities"](request, {}),
        ),
      "Repositories.setFavorite": (request: ApplicationRpcRequest<"Repositories.setFavorite">) =>
        handle("Repositories.setFavorite", request, (methods) =>
          methods["Repositories.setFavorite"](request, {}),
        ),
      "ProjectWorkspace.get": (request: ApplicationRpcRequest<"ProjectWorkspace.get">) =>
        handle("ProjectWorkspace.get", request, (methods) =>
          methods["ProjectWorkspace.get"](request, {}),
        ),
      "ProjectWorkspace.save": (request: ApplicationRpcRequest<"ProjectWorkspace.save">) =>
        handle("ProjectWorkspace.save", request, (methods) =>
          methods["ProjectWorkspace.save"](request, {}),
        ),
      "ReviewThreads.addUserMessage": (
        request: ApplicationRpcRequest<"ReviewThreads.addUserMessage">,
      ) =>
        handle("ReviewThreads.addUserMessage", request, (methods) =>
          methods["ReviewThreads.addUserMessage"](request, {}),
        ),
      "ReviewThreads.create": (request: ApplicationRpcRequest<"ReviewThreads.create">) =>
        handle("ReviewThreads.create", request, (methods) =>
          methods["ReviewThreads.create"](request, {
            applicationInstanceId: request.applicationInstanceId,
            processEpoch: request.processEpoch,
          }),
        ),
      "ReviewThreads.get": (request: ApplicationRpcRequest<"ReviewThreads.get">) =>
        handle("ReviewThreads.get", request, (methods) =>
          methods["ReviewThreads.get"](request, {}),
        ),
      "ReviewThreads.list": (request: ApplicationRpcRequest<"ReviewThreads.list">) =>
        handle("ReviewThreads.list", request, (methods) =>
          methods["ReviewThreads.list"](request, {
            applicationInstanceId: request.applicationInstanceId,
            processEpoch: request.processEpoch,
          }),
        ),
      "Settings.get": (request: ApplicationRpcRequest<"Settings.get">) =>
        handle("Settings.get", request, (methods) => methods["Settings.get"](request, {})),
      "Settings.update": (request: ApplicationRpcRequest<"Settings.update">) =>
        handle("Settings.update", request, (methods) => methods["Settings.update"](request, {})),
      "Resources.diagnostics": (request: ApplicationRpcRequest<"Resources.diagnostics">) =>
        handle("Resources.diagnostics", request, (methods) =>
          methods["Resources.diagnostics"](request, {}),
        ),
      "Resources.clearDisposable": (request: ApplicationRpcRequest<"Resources.clearDisposable">) =>
        handle("Resources.clearDisposable", request, (methods) =>
          methods["Resources.clearDisposable"](request, {}),
        ),
      "E2E.reviewLifecycleDiagnostics": (_request: HostRequestContext) =>
        runtime.reviewLifecycleDiagnostics.pipe(
          Effect.flatMap((diagnostics) => diagnostics.snapshot),
        ),
      "E2E.holdNextReviewAcquisition": (_request: HostRequestContext) =>
        runtime.reviewLifecycleDiagnostics.pipe(
          Effect.flatMap((diagnostics) => diagnostics.holdNextAcquisition),
          Effect.map((armed) => ({ armed })),
        ),
      "ViewedFiles.listHosted": (request: ApplicationRpcRequest<"ViewedFiles.listHosted">) =>
        handle("ViewedFiles.listHosted", request, (methods) =>
          methods["ViewedFiles.listHosted"](request, {}),
        ),
      "ViewedFiles.listLocal": (request: ApplicationRpcRequest<"ViewedFiles.listLocal">) =>
        handle("ViewedFiles.listLocal", request, (methods) =>
          methods["ViewedFiles.listLocal"](request, {}),
        ),
      "ViewedFiles.setHosted": (request: ApplicationRpcRequest<"ViewedFiles.setHosted">) =>
        handle("ViewedFiles.setHosted", request, (methods) =>
          methods["ViewedFiles.setHosted"](request, {}),
        ),
      "ViewedFiles.setLocal": (request: ApplicationRpcRequest<"ViewedFiles.setLocal">) =>
        handle("ViewedFiles.setLocal", request, (methods) =>
          methods["ViewedFiles.setLocal"](request, {}),
        ),
      "ViewedFiles.listRepositoryComparison": (
        request: ApplicationRpcRequest<"ViewedFiles.listRepositoryComparison">,
      ) =>
        handle("ViewedFiles.listRepositoryComparison", request, (methods) =>
          methods["ViewedFiles.listRepositoryComparison"](request, {}),
        ),
      "ViewedFiles.setRepositoryComparison": (
        request: ApplicationRpcRequest<"ViewedFiles.setRepositoryComparison">,
      ) =>
        handle("ViewedFiles.setRepositoryComparison", request, (methods) =>
          methods["ViewedFiles.setRepositoryComparison"](request, {}),
        ),
    }

    return handlers
  }),
)
