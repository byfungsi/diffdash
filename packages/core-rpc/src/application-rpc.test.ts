import { describe, expect, it } from "@effect/vitest"
import { Option, Schema } from "effect"

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
  "ReviewSnapshots.getPage",
  "ReviewSnapshots.search",
  "Repositories.favoriteRemote",
  "Repositories.forget",
  "Repositories.install",
  "Repositories.link",
  "Repositories.list",
  "Repositories.openProject",
  "Repositories.repairIdentities",
  "Repositories.setFavorite",
  "ProjectWorkspace.get",
  "ProjectWorkspace.save",
  "ReviewThreads.addUserMessage",
  "ReviewThreads.create",
  "ReviewThreads.get",
  "ReviewThreads.list",
  "ReviewThreads.runAgent",
  "Settings.get",
  "Settings.update",
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

    expect(coreMethods).toHaveLength(48)
    expect(new Set(coreMethods)).toHaveLength(48)
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
})
