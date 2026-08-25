import {
  CoreApplicationFailureCode,
  CoreApplicationRpcs,
  makeCoreApplicationAdmissionFailure,
  type CoreApplicationAdmissionFailureCode,
  type CoreApplicationFailure,
} from "@diffdash/core-rpc/application-rpc"
import { CORE_RPC_INCOMPLETE_BUFFER_BYTES } from "@diffdash/core-rpc/transport"
import {
  CodeWorkspaceError,
  type CodeWorkspaceFailureReason,
} from "@diffdash/domain/code-workspace"
import { getCoreRpcMethodPolicy, type CoreRpcMethodPolicy } from "@diffdash/core-rpc/method-policy"
import { Cause, Effect, Fiber, FiberSet, Option, Predicate, Schema } from "effect"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"

import type { HostRequestContext } from "@diffdash/core-rpc/identity"
import type {
  CoreMethod as CoreMethodType,
  CoreMethodInput,
  CoreOperationFailure,
  CoreOperationOutput,
} from "./core-contract"
import { CoreLifecycle } from "./core-lifecycle"
import { CoreRuntimeServices } from "./core-runtime-services"
import type { OperationHandlers } from "./operations/operation-handlers"

type ApplicationRpcRequest<Method extends CoreMethodType> = HostRequestContext &
  CoreMethodInput<Method>

const makeMethodPolicyParser = () =>
  RpcSerialization.makeMsgPack({
    useRecords: true,
    maxBufferSize: CORE_RPC_INCOMPLETE_BUFFER_BYTES,
  }).makeUnsafe()

const encodedBytes = (value: Parameters<ReturnType<typeof makeMethodPolicyParser>["encode"]>[0]) =>
  Effect.try(() => makeMethodPolicyParser().encode(value)).pipe(
    Effect.filterOrFail(
      (encoded) => encoded !== undefined,
      () => undefined,
    ),
    Effect.map((encoded) =>
      Predicate.isString(encoded) ? Buffer.byteLength(encoded) : encoded.byteLength,
    ),
  )

const codeWorkspaceFailureDetails = {
  invalidPath: {
    code: "CODE_WORKSPACE_INVALID_PATH",
    safeMessage: "The requested repository path is invalid.",
  },
  leaseExpired: {
    code: "CODE_WORKSPACE_LEASE_EXPIRED",
    safeMessage: "The Code workspace lease expired.",
  },
  leaseNotFound: {
    code: "CODE_WORKSPACE_LEASE_NOT_FOUND",
    safeMessage: "The Code workspace lease is no longer available.",
  },
  repositoryNotFound: {
    code: "CODE_WORKSPACE_REPOSITORY_NOT_FOUND",
    safeMessage: "The repository is no longer available.",
  },
  repositoryUnavailable: {
    code: "CODE_WORKSPACE_REPOSITORY_UNAVAILABLE",
    safeMessage: "The linked repository checkout is unavailable.",
  },
  revisionUnavailable: {
    code: "CODE_WORKSPACE_REVISION_UNAVAILABLE",
    safeMessage: "Git could not resolve the repository's current revision.",
  },
  snapshotUnavailable: {
    code: "CODE_WORKSPACE_SNAPSHOT_UNAVAILABLE",
    safeMessage: "The review snapshot is no longer available.",
  },
  workspaceUnavailable: {
    code: "CODE_WORKSPACE_UNAVAILABLE",
    safeMessage: "The Code workspace could not be prepared.",
  },
} as const satisfies Record<
  CodeWorkspaceFailureReason,
  { readonly code: CoreApplicationFailure["code"]; readonly safeMessage: string }
>

/** Converts an operation failure into bounded method-scoped RPC diagnostics. */
export const makeCoreApplicationOperationFailure = <Method extends CoreMethodType>(
  method: Method,
  request: HostRequestContext,
  error: CoreOperationFailure<Method>,
): CoreApplicationFailure<Method> => {
  if (Schema.is(CodeWorkspaceError)(error)) {
    const details = codeWorkspaceFailureDetails[error.reason]
    return {
      _tag: "CoreApplicationFailure",
      applicationInstanceId: request.applicationInstanceId,
      processEpoch: request.processEpoch,
      requestId: request.requestId,
      method,
      code: CoreApplicationFailureCode.make(details.code),
      retryClass: "userAction",
      safeMessage: details.safeMessage,
    }
  }
  return {
    _tag: "CoreApplicationFailure",
    applicationInstanceId: request.applicationInstanceId,
    processEpoch: request.processEpoch,
    requestId: request.requestId,
    method,
    code: CoreApplicationFailureCode.make("APPLICATION_OPERATION_FAILED"),
    retryClass: "userAction",
    safeMessage: "DiffDash Core could not complete this application operation.",
  }
}

/** Native per-method handlers backed by the installed Core operation authority. */
export const coreApplicationRpcHandlersLayer = CoreApplicationRpcs.toLayer(
  Effect.gen(function* () {
    const runtime = yield* CoreRuntimeServices
    const lifecycle = yield* CoreLifecycle
    const detachedRequests = yield* FiberSet.make()

    const admit = <Method extends string, A, E>(
      method: Method,
      request: HostRequestContext,
      operation: Effect.Effect<A, E>,
    ): Effect.Effect<A, E | CoreApplicationFailure<Method>> => {
      const declaration = CoreApplicationRpcs.requests.get(method)
      const policy =
        declaration === undefined
          ? Option.none<CoreRpcMethodPolicy>()
          : getCoreRpcMethodPolicy(declaration)
      const fail = (code: CoreApplicationAdmissionFailureCode) => {
        const failure = makeCoreApplicationAdmissionFailure(method, request, code)
        return Effect.fail(
          code === "REQUEST_DEADLINE_EXCEEDED" &&
            Option.isSome(policy) &&
            policy.value.idempotency === "nonIdempotent"
            ? { ...failure, retryClass: "notRetryable" as const }
            : failure,
        )
      }

      if (Option.isNone(policy)) return fail("CORE_RPC_POLICY_ERROR")

      const withinBudget = (value: Parameters<typeof encodedBytes>[0], maximumBytes: number) =>
        encodedBytes(value).pipe(
          Effect.filterOrFail(
            (size) => size <= maximumBytes,
            () => undefined,
          ),
        )
      const interruptOnDrain = <Value, Error>(
        effect: Effect.Effect<Value, Error>,
      ): Effect.Effect<Value, Error | CoreApplicationFailure<Method>> =>
        lifecycle
          .interruptOnDrain(effect)
          .pipe(
            Effect.catchCause(
              (cause): Effect.Effect<never, Error | CoreApplicationFailure<Method>> =>
                Cause.hasInterruptsOnly(cause) ? fail("CORE_DRAINING") : Effect.failCause(cause),
            ),
          )
      const drainAware = interruptOnDrain(operation)
      const cancellable =
        policy.value.cancellation === "interruptible"
          ? drainAware
          : Effect.uninterruptibleMask((restore) =>
              FiberSet.run(
                detachedRequests,
                policy.value.cancellation === "uninterruptible"
                  ? Effect.uninterruptible(operation)
                  : drainAware,
              ).pipe(Effect.flatMap((fiber) => restore(Fiber.join(fiber)))),
            )

      const admitted = withinBudget(request, policy.value.maxRequestBytes).pipe(
        Effect.catch(() => fail("REQUEST_TOO_LARGE")),
        Effect.andThen(
          lifecycle.admitBusinessRequest(request).pipe(
            Effect.catchTags({
              CoreBusinessIdentityMismatchError: () => fail("CORE_REQUEST_IDENTITY_MISMATCH"),
              CoreBusinessLifecycleRejectedError: (error) =>
                fail(
                  error.lifecycle === "draining" || error.lifecycle === "stopped"
                    ? "CORE_DRAINING"
                    : "CORE_LIFECYCLE_REJECTED",
                ),
            }),
          ),
        ),
        Effect.andThen(cancellable),
        Effect.flatMap((result) =>
          withinBudget(result, policy.value.maxResponseBytes).pipe(
            Effect.catch(() => fail("RESPONSE_TOO_LARGE")),
            Effect.as(result),
          ),
        ),
      )
      return policy.value.cancellation === "uninterruptible"
        ? admitted
        : admitted.pipe(
            Effect.timeoutOrElse({
              duration: policy.value.deadlineMs,
              orElse: () => fail("REQUEST_DEADLINE_EXCEEDED"),
            }),
          )
    }

    const handle = <Method extends CoreMethodType>(
      method: Method,
      request: ApplicationRpcRequest<Method>,
      invoke: (
        methods: OperationHandlers,
      ) => Effect.Effect<CoreOperationOutput<Method>, CoreOperationFailure<Method>>,
    ) => {
      const declaration = CoreApplicationRpcs.requests.get(method)
      const methodPolicy =
        declaration === undefined ? Option.none() : getCoreRpcMethodPolicy(declaration)
      return admit(
        method,
        request,
        runtime.operations.pipe(
          Effect.flatMap((operations) => invoke(operations.methods)),
          Effect.mapError((error) => {
            const failure = makeCoreApplicationOperationFailure(method, request, error)
            return Option.isSome(methodPolicy) && methodPolicy.value.idempotency === "nonIdempotent"
              ? { ...failure, retryClass: "notRetryable" as const }
              : failure
          }),
        ),
      )
    }

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
      "CodeWorkspace.open": (request: ApplicationRpcRequest<"CodeWorkspace.open">) =>
        handle("CodeWorkspace.open", request, (methods) =>
          methods["CodeWorkspace.open"](request, request),
        ),
      "CodeWorkspace.heartbeat": (request: ApplicationRpcRequest<"CodeWorkspace.heartbeat">) =>
        handle("CodeWorkspace.heartbeat", request, (methods) =>
          methods["CodeWorkspace.heartbeat"](request, request),
        ),
      "CodeWorkspace.release": (request: ApplicationRpcRequest<"CodeWorkspace.release">) =>
        handle("CodeWorkspace.release", request, (methods) =>
          methods["CodeWorkspace.release"](request, request),
        ),
      "CodeWorkspace.listDirectory": (
        request: ApplicationRpcRequest<"CodeWorkspace.listDirectory">,
      ) =>
        handle("CodeWorkspace.listDirectory", request, (methods) =>
          methods["CodeWorkspace.listDirectory"](request, request),
        ),
      "CodeWorkspace.search": (request: ApplicationRpcRequest<"CodeWorkspace.search">) =>
        handle("CodeWorkspace.search", request, (methods) =>
          methods["CodeWorkspace.search"](request, request),
        ),
      "CodeWorkspace.readFile": (request: ApplicationRpcRequest<"CodeWorkspace.readFile">) =>
        handle("CodeWorkspace.readFile", request, (methods) =>
          methods["CodeWorkspace.readFile"](request, request),
        ),
      "CodeWorkspace.definitions": (request: ApplicationRpcRequest<"CodeWorkspace.definitions">) =>
        handle("CodeWorkspace.definitions", request, (methods) =>
          methods["CodeWorkspace.definitions"](request, request),
        ),
      "CodeWorkspace.references": (request: ApplicationRpcRequest<"CodeWorkspace.references">) =>
        handle("CodeWorkspace.references", request, (methods) =>
          methods["CodeWorkspace.references"](request, request),
        ),
      "CodeWorkspace.changes": (request: ApplicationRpcRequest<"CodeWorkspace.changes">) =>
        handle("CodeWorkspace.changes", request, (methods) =>
          methods["CodeWorkspace.changes"](request, request),
        ),
      "CodeWorkspace.lineChanges": (request: ApplicationRpcRequest<"CodeWorkspace.lineChanges">) =>
        handle("CodeWorkspace.lineChanges", request, (methods) =>
          methods["CodeWorkspace.lineChanges"](request, request),
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
        ).pipe(Effect.map(Option.getOrNull)),
      "ProjectWorkspace.save": (request: ApplicationRpcRequest<"ProjectWorkspace.save">) =>
        handle("ProjectWorkspace.save", request, (methods) =>
          methods["ProjectWorkspace.save"](request, {}),
        ),
      "OpenCode.listSessions": (request: ApplicationRpcRequest<"OpenCode.listSessions">) =>
        handle("OpenCode.listSessions", request, (methods) =>
          methods["OpenCode.listSessions"](request, {}),
        ),
      "OpenCode.connectSession": (request: ApplicationRpcRequest<"OpenCode.connectSession">) =>
        handle("OpenCode.connectSession", request, (methods) =>
          methods["OpenCode.connectSession"](request, {}),
        ),
      "CommentSubmission.submit": (request: ApplicationRpcRequest<"CommentSubmission.submit">) =>
        handle("CommentSubmission.submit", request, (methods) =>
          methods["CommentSubmission.submit"](request, {
            applicationInstanceId: request.applicationInstanceId,
            processEpoch: request.processEpoch,
            requestId: request.requestId,
          }),
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
      "E2E.reviewLifecycleDiagnostics": (request: HostRequestContext) =>
        admit(
          "E2E.reviewLifecycleDiagnostics",
          request,
          runtime.reviewLifecycleDiagnostics.pipe(
            Effect.flatMap((diagnostics) => diagnostics.snapshot),
          ),
        ),
      "E2E.holdNextReviewAcquisition": (request: HostRequestContext) =>
        admit(
          "E2E.holdNextReviewAcquisition",
          request,
          runtime.reviewLifecycleDiagnostics.pipe(
            Effect.flatMap((diagnostics) => diagnostics.holdNextAcquisition),
            Effect.map((armed) => ({ armed })),
          ),
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
