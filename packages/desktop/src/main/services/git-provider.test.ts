import {
  GitProviderCapabilities,
  GitProviderDescriptor,
  GitProviderDiagnostic,
  GitProviderId,
  GitProviderKind,
  GitProviderTerminology,
} from "@diffdash/domain/git-provider"
import { type GitProviderRegistration, GitProviderRegistry } from "@diffdash/git-provider"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { GitProvider } from "./git-provider"

describe("GitProvider", () => {
  it.effect("requires provider support and authentication for remote acquisition", () => {
    const providerId = GitProviderId.make("test")
    const unexpectedOperation = () => Effect.dieMessage("Unexpected provider operation")
    const provider = {
      descriptor: GitProviderDescriptor.make({
        id: providerId,
        kind: GitProviderKind.make("test"),
        displayName: "Test",
        host: "git.example.com",
        capabilities: GitProviderCapabilities.make({
          repositorySearch: false,
          searchScopes: false,
          assignedReviews: false,
          reviewDecisions: false,
          fileUrls: false,
          remoteWorkspaceBootstrap: true,
        }),
        terminology: GitProviderTerminology.make({
          repositorySingular: "repository",
          repositoryPlural: "repositories",
          reviewSingular: "review",
          reviewPlural: "reviews",
        }),
      }),
      publishingTools: [],
      diagnose: Effect.succeed(
        GitProviderDiagnostic.make({
          providerId,
          available: true,
          authenticated: false,
          message: "Authenticate the test provider.",
        }),
      ),
      parseRemote: unexpectedOperation,
      searchRepositories: unexpectedOperation,
      listReviews: unexpectedOperation,
      getReview: unexpectedOperation,
      getReviewDiff: unexpectedOperation,
      getReviewDecision: unexpectedOperation,
      submitReviewDecision: unexpectedOperation,
      repositoryUrl: unexpectedOperation,
      fileUrl: unexpectedOperation,
      bootstrapBareRepository: unexpectedOperation,
      checkoutSpec: unexpectedOperation,
    } satisfies GitProviderRegistration
    const layer = GitProvider.layer.pipe(Layer.provide(GitProviderRegistry.layer([provider])))

    return Effect.gen(function* () {
      const providers = yield* GitProvider
      expect(yield* providers.isAvailable(providerId)).toBe(false)
    }).pipe(Effect.provide(layer))
  })
})
