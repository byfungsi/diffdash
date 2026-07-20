import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import {
  GitProviderId,
  GitProviderKind,
  BranchRevision,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewSummary,
  HostedReviewLocator,
  HostedReviewNumber,
  makeHostedRepositoryLocator,
  makeHostedRepositoryKey,
  makeHostedReviewLocator,
  makeHostedReviewKey,
  RepositoryNamespace,
  ProviderActor,
  sameHostedRepository,
  sameHostedReview,
} from "./git-provider"

const locator = (providerId: string, namespace = "fungsi", name = "diffdash") =>
  HostedRepositoryLocator.make({
    providerId: GitProviderId.make(providerId),
    namespace: RepositoryNamespace.make(namespace),
    name: HostedRepositoryName.make(name),
  })

describe("hosted Git provider identities", () => {
  it("preserves existing GitHub repository and review keys", () => {
    const repository = makeHostedRepositoryLocator("github", "fungsi", "diffdash")
    const review = makeHostedReviewLocator("github", "fungsi", "diffdash", 51)

    expect(makeHostedRepositoryKey(repository)).toBe("github:fungsi/diffdash")
    expect(makeHostedReviewKey(review)).toBe("github:fungsi/diffdash#51")
  })

  it("isolates equal repositories across kinds and configured instances", () => {
    const keys = [locator("github"), locator("github-enterprise"), locator("gitlab-acme")].map(
      makeHostedRepositoryKey,
    )

    expect(new Set(keys)).toHaveLength(keys.length)
  })

  it("compares complete repository and review identity", () => {
    const repository = makeHostedRepositoryLocator("github", "fungsi", "diffdash")
    const sameRepository = makeHostedRepositoryLocator("github", "fungsi", "diffdash")
    const otherRepository = makeHostedRepositoryLocator("github", "fungsi", "dashboard")
    const review = makeHostedReviewLocator("github", "fungsi", "diffdash", 51)

    expect(sameHostedRepository(repository, sameRepository)).toBe(true)
    expect(
      sameHostedRepository(repository, makeHostedRepositoryLocator("github", "FUNGSI", "DiffDash")),
    ).toBe(true)
    expect(sameHostedRepository(repository, otherRepository)).toBe(false)
    expect(
      sameHostedReview(review, makeHostedReviewLocator("github", "fungsi", "diffdash", 51)),
    ).toBe(true)
    expect(
      sameHostedReview(review, makeHostedReviewLocator("github", "fungsi", "diffdash", 52)),
    ).toBe(false)
  })

  it("supports nested namespaces and self-hosted instance IDs", () => {
    const repository = locator("git.example.com", "platform/backend", "service")
    expect(makeHostedRepositoryKey(repository)).toBe("git.example.com:platform/backend/service")
    expect(Schema.decodeUnknownSync(HostedRepositoryLocator)(repository)).toEqual(repository)
  })

  it("keeps provider implementation kind separate from instance identity", () => {
    expect(GitProviderKind.make("github")).toBe("github")
    expect(GitProviderId.make("github-enterprise")).toBe("github-enterprise")
  })

  it("round-trips provider-neutral review metadata with its locator", () => {
    const review = HostedReviewSummary.make({
      locator: HostedReviewLocator.make({
        repository: locator("github-enterprise", "platform/backend", "service"),
        number: HostedReviewNumber.make(42),
      }),
      title: "Provider-neutral review",
      body: null,
      author: ProviderActor.make({
        id: "user-1",
        username: "hanif",
        displayName: "Hanif",
        avatarUrl: null,
      }),
      state: "open",
      decision: "approved",
      url: "https://git.example.com/platform/backend/service/reviews/42",
      draft: false,
      base: BranchRevision.make({ name: "main", revision: "base" }),
      head: BranchRevision.make({ name: "feature", revision: "head" }),
      createdAt: null,
      updatedAt: null,
    })

    const decoded = Schema.decodeUnknownSync(HostedReviewSummary)(review)
    expect(decoded.locator.repository.providerId).toBe("github-enterprise")
    expect(decoded.locator.repository.namespace).toBe("platform/backend")
  })

  it("rejects the reserved local marker and malformed locators", () => {
    expect(() => Schema.decodeUnknownSync(GitProviderId)("local")).toThrow(/./)
    expect(() => Schema.decodeUnknownSync(RepositoryNamespace)("platform//backend")).toThrow(/./)
    expect(() => Schema.decodeUnknownSync(HostedReviewNumber)(0)).toThrow(/./)
  })
})
