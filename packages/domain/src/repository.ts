import { Schema } from "effect"

import {
  GitProviderId,
  HostedRepositorySource,
  LocalRepositorySource,
  makeHostedRepositoryLocator,
  type RepositorySource,
} from "./git-provider"

/** Persisted provider instance ID, or the reserved legacy local-source marker. */
export const RepoProvider = Schema.String.pipe(Schema.minLength(1))

/** Persisted provider instance ID, or the reserved legacy local-source marker. */
export type RepoProvider = typeof RepoProvider.Type

/** A local or remote-only repository saved in the DiffDash workspace. */
export class Repo extends Schema.Class<Repo>("Repo")({
  id: Schema.String,
  provider: RepoProvider,
  owner: Schema.String,
  name: Schema.String,
  remoteUrl: Schema.String,
  localPath: Schema.NullOr(Schema.String),
  isFavorite: Schema.Boolean,
  lastOpenedAt: Schema.NullOr(Schema.String),
  lastSyncedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

/** A provider account or organization that can scope repository search. */
export class RepositorySearchScope extends Schema.Class<RepositorySearchScope>(
  "RepositorySearchScope",
)({
  login: Schema.String,
  kind: Schema.Literal("user", "organization"),
}) {}

/** Owner-scoped input for searching repositories through a Git provider. */
export class RepositorySearchRequest extends Schema.Class<RepositorySearchRequest>(
  "RepositorySearchRequest",
)({
  providerId: GitProviderId,
  query: Schema.String,
  owners: Schema.Array(Schema.String),
}) {}

/** Input for creating or updating a repository record. */
export interface UpsertRepositoryInput {
  readonly provider: RepoProvider
  readonly owner: string
  readonly name: string
  readonly remoteUrl: string
  readonly localPath: string | null
  readonly isFavorite?: boolean
}

/** Repository checkout metadata detected from local Git. */
export interface DetectedRepositoryCheckout {
  readonly rootPath: string
  readonly remoteUrl: string
}

/** Provider-owned repository identity parsed from a remote URL. */
export interface ProviderRepositoryReference {
  readonly provider: RepoProvider
  readonly owner: string
  readonly name: string
}

/** Interprets the compatibility persistence shape as a local or hosted source. */
export const repositorySource = (
  repo: Pick<Repo, "provider" | "owner" | "name">,
): RepositorySource =>
  repo.provider === "local"
    ? LocalRepositorySource.make()
    : HostedRepositorySource.make({
        locator: makeHostedRepositoryLocator(repo.provider, repo.owner, repo.name),
      })
