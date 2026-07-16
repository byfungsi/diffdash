import {
  GitProviderId,
  HostedRepositoryLocator,
  HostedRepositoryName,
  HostedReviewLocator,
  HostedReviewNumber,
  RepositoryNamespace,
} from "@diffdash/domain/git-provider"
import type { Repo } from "@diffdash/domain/repository"
import { makePullRequestReviewKey } from "@diffdash/domain/review-identity"
import { createHash } from "node:crypto"
import { basename, resolve } from "node:path"
import { pathToFileURL } from "node:url"

/** Builds the persisted key for a hosted review. */
export const pullRequestReviewKey = (
  provider: Repo["provider"],
  owner: string,
  name: string,
  number: number,
) => makePullRequestReviewKey(provider, owner, name, number)

/** Builds a typed hosted review locator. */
export const hostedReview = (providerId: string, owner: string, name: string, number: number) =>
  HostedReviewLocator.make({
    repository: HostedRepositoryLocator.make({
      providerId: GitProviderId.make(providerId),
      namespace: RepositoryNamespace.make(owner),
      name: HostedRepositoryName.make(name),
    }),
    number: HostedReviewNumber.make(number),
  })

/** Builds the persisted identity for a local repository. */
export const localRepositoryInput = (rootPath: string) => {
  const resolvedRootPath = resolve(rootPath)
  const hash = hashText(resolvedRootPath).slice(0, 12)
  const repoName = basename(resolvedRootPath) || "repository"
  return {
    provider: "local",
    owner: "local",
    name: `${repoName}-${hash}`,
    remoteUrl: pathToFileURL(resolvedRootPath).toString(),
    localPath: resolvedRootPath,
    isFavorite: false,
  } as const
}

const hashText = (text: string) => createHash("sha256").update(text).digest("hex")
