import { describe, expect, it } from "@effect/vitest"
import { HashSet, Option, Schema } from "effect"

import { CoreApplicationRpcs } from "./application-rpc"
import { AppStateBusinessRpcs, AppStateUpdateRpcs } from "./business"
import { getCoreRpcMethodPolicy } from "./method-policy"
import { ReviewAgentBusinessRpcs } from "./review-agent-rpc"

const coreMethods = [
  "Analytics.capture",
  "Analytics.start",
  "AgentProviders.getCatalog",
  "Prerequisites.get",
  "Prerequisites.installDiffDashCli",
  "FileNavigation.resolveLocalRepositoryFile",
  "FileNavigation.resolveRepositoryComparisonFile",
  "FileNavigation.resolveHostedReviewFile",
  "AppState.get",
  "AppState.update",
  "GitProviders.list",
  "HostedReviews.submitDecision",
  "HostedReviews.getDecision",
  "HostedReviews.getDetail",
  "HostedReviews.getChecks",
  "HostedReviews.close",
  "HostedReviews.merge",
  "HostedReviews.updateBranch",
  "HostedReviews.list",
  "HostedReviews.listAssigned",
  "GitProviders.listSearchScopes",
  "GitProviders.searchRepositories",
  "LocalReviews.resolveBranch",
  "LocalReviews.resolveLastCommit",
  "RepositoryComparisons.resolve",
  "ReviewSnapshots.acquireHosted",
  "ReviewSnapshots.acquireLocal",
  "ReviewSnapshots.acquireRepositoryComparison",
  "Repositories.favoriteRemote",
  "Repositories.forget",
  "Repositories.install",
  "Repositories.link",
  "Repositories.list",
  "Repositories.openProject",
  "Repositories.repairIdentities",
  "Repositories.setFavorite",
  "CodeWorkspace.open",
  "CodeWorkspace.heartbeat",
  "CodeWorkspace.release",
  "CodeWorkspace.listDirectory",
  "CodeWorkspace.search",
  "CodeWorkspace.readFile",
  "CodeWorkspace.definitions",
  "CodeWorkspace.references",
  "CodeWorkspace.changes",
  "CodeWorkspace.lineChanges",
  "ProjectWorkspace.get",
  "ProjectWorkspace.save",
  "OpenCode.listSessions",
  "OpenCode.connectSession",
  "CommentSubmission.submit",
  "ReviewThreads.addUserMessage",
  "ReviewThreads.create",
  "ReviewThreads.get",
  "ReviewThreads.list",
  "ReviewThreads.runAgent",
  "Settings.get",
  "Settings.update",
  "Resources.diagnostics",
  "Resources.clearDisposable",
  "ViewedFiles.listHosted",
  "ViewedFiles.listLocal",
  "ViewedFiles.setHosted",
  "ViewedFiles.setLocal",
  "ViewedFiles.listRepositoryComparison",
  "ViewedFiles.setRepositoryComparison",
] as const

describe("Core application RPC catalog", () => {
  it("declares one native tag and complete policy for every CoreMethod", () => {
    const declarations = CoreApplicationRpcs.merge(AppStateBusinessRpcs)
      .merge(AppStateUpdateRpcs)
      .merge(ReviewAgentBusinessRpcs)
    const coreDeclarations = coreMethods.map((method) => declarations.requests.get(method))

    expect(coreMethods).toHaveLength(66)
    expect(HashSet.size(HashSet.fromIterable(coreMethods))).toBe(66)
    expect(coreDeclarations.every((declaration) => declaration !== undefined)).toBe(true)
    expect(
      coreDeclarations.every(
        (declaration) =>
          declaration !== undefined && Option.isSome(getCoreRpcMethodPolicy(declaration)),
      ),
    ).toBe(true)
  })

  it("parses each method payload with its own schema", () => {
    const settings = CoreApplicationRpcs.requests.get("Settings.update")
    const repositories = CoreApplicationRpcs.requests.get("Repositories.list")

    expect(settings).toBeDefined()
    expect(repositories).toBeDefined()
    if (settings === undefined || repositories === undefined) return

    expect(Schema.decodeUnknownResult(settings.payloadSchema)({ query: null })._tag).toBe("Failure")
    expect(
      Schema.decodeUnknownResult(repositories.payloadSchema)({
        applicationInstanceId: "app-1",
        processEpoch: "epoch-1",
        requestId: "h:request-1",
        query: null,
      })._tag,
    ).toBe("Success")
  })

  it("bounds resource diagnostics and models clear-cache as an idempotent mutation", () => {
    const diagnostics = CoreApplicationRpcs.requests.get("Resources.diagnostics")
    const clear = CoreApplicationRpcs.requests.get("Resources.clearDisposable")

    expect(diagnostics).toBeDefined()
    expect(clear).toBeDefined()
    if (diagnostics === undefined || clear === undefined) return

    const diagnosticsPolicy = Option.getOrThrow(getCoreRpcMethodPolicy(diagnostics))
    const clearPolicy = Option.getOrThrow(getCoreRpcMethodPolicy(clear))
    expect(diagnosticsPolicy.maxResponseBytes).toBe(16 * 1_024)
    expect(diagnosticsPolicy.mutationClass).toBe("read")
    expect(clearPolicy.maxResponseBytes).toBe(16 * 1_024)
    expect(clearPolicy.mutationClass).toBe("idempotentMutation")
    expect(clearPolicy.idempotency).toBe("idempotent")
  })

  it("keeps comment acceptance running after caller interruption with a small receipt", () => {
    const submission = CoreApplicationRpcs.requests.get("CommentSubmission.submit")

    expect(submission).toBeDefined()
    if (submission === undefined) return

    const submissionPolicy = Option.getOrThrow(getCoreRpcMethodPolicy(submission))
    expect(submissionPolicy.maxRequestBytes).toBe(64 * 1_024)
    expect(submissionPolicy.maxResponseBytes).toBe(4 * 1_024)
    expect(submissionPolicy.cancellation).toBe("uninterruptible")
    expect(submissionPolicy.idempotency).toBe("nonIdempotent")
    expect(submissionPolicy.restartBehavior).toBe("failOnRestart")
  })

  it("models hosted review close and merge as non-idempotent mutations", () => {
    for (const method of [
      "HostedReviews.close",
      "HostedReviews.merge",
      "HostedReviews.updateBranch",
    ] as const) {
      const declaration = CoreApplicationRpcs.requests.get(method)
      expect(declaration).toBeDefined()
      if (declaration === undefined) continue
      const policy = Option.getOrThrow(getCoreRpcMethodPolicy(declaration))
      expect(policy.mutationClass).toBe("uncertainMutation")
      expect(policy.idempotency).toBe("nonIdempotent")
      expect(policy.restartBehavior).toBe("failOnRestart")
    }
  })

  it("round-trips guarded hosted merge input through its RPC payload schema", () => {
    const merge = CoreApplicationRpcs.requests.get("HostedReviews.merge")
    expect(merge).toBeDefined()
    if (merge === undefined) return
    const payload = {
      applicationInstanceId: "app-1",
      processEpoch: "epoch-1",
      requestId: "h:request-1",
      review: {
        repository: {
          providerId: "github",
          namespace: "fungsi",
          name: "diffdash",
        },
        number: 42,
      },
      method: "squash",
      bypassRules: true,
      expectedHeadRevision: "expected-head",
    }

    const decoded = Schema.decodeUnknownSync(merge.payloadSchema)(payload)
    expect(Schema.encodeSync(merge.payloadSchema)(decoded)).toEqual(payload)
    expect(
      Schema.decodeUnknownResult(merge.payloadSchema)({
        ...payload,
        expectedHeadRevision: undefined,
      })._tag,
    ).toBe("Failure")
  })
})
