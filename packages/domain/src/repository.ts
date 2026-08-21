import { Schema } from "effect"

import {
  GitProviderId,
  type HostedRepositoryLocator,
  HostedRepositorySource,
  LocalRepositorySource,
  RepositorySource,
  sameHostedRepository,
} from "./git-provider"
import { ReviewProjectId } from "./review-identity"

/** Absolute checkout path stored for a repository linked on this machine. */
export const RepositoryCheckoutPath = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(
    Schema.makeFilter(
      (value) =>
        value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\"),
      { message: "Expected an absolute repository checkout path" },
    ),
  ),
  Schema.brand("RepositoryCheckoutPath"),
)

/** Absolute checkout path stored for a repository linked on this machine. */
export type RepositoryCheckoutPath = typeof RepositoryCheckoutPath.Type

/** Linked checkout path when available to an operation on this machine. */
export type RepositoryLocalPath = RepositoryCheckoutPath | null

/** A hosted repository without a checkout on this machine. */
export class RemoteOnly extends Schema.TaggedClass<RemoteOnly>()("RemoteOnly", {
  remoteUrl: Schema.String,
}) {}

/** A repository linked to a checkout on this machine. */
export class LinkedCheckout extends Schema.TaggedClass<LinkedCheckout>()("LinkedCheckout", {
  remoteUrl: Schema.String,
  path: RepositoryCheckoutPath,
}) {}

/** Repository availability independent from its local or hosted source identity. */
export const RepositoryCheckout = Schema.Union([RemoteOnly, LinkedCheckout]).pipe(
  Schema.toTaggedUnion("_tag"),
)

/** Repository availability independent from its local or hosted source identity. */
export type RepositoryCheckout = typeof RepositoryCheckout.Type

const RepositoryIdentityFields = {
  source: RepositorySource,
  checkout: RepositoryCheckout,
} as const

/** Favorite-state intent applied while creating or updating a repository. */
export const RepositoryFavoriteIntent = Schema.Literals(["preserve", "mark"])

/** Favorite-state intent applied while creating or updating a repository. */
export type RepositoryFavoriteIntent = typeof RepositoryFavoriteIntent.Type

const RepoFields = Schema.Struct({
  ...RepositoryIdentityFields,
  id: ReviewProjectId,
  isFavorite: Schema.Boolean,
  lastOpenedAt: Schema.NullOr(Schema.String),
  lastSyncedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).check(
  Schema.makeFilter(
    ({ source, checkout }) =>
      !Schema.is(LocalRepositorySource)(source) || Schema.is(LinkedCheckout)(checkout),
    { message: "A local repository source requires a linked checkout" },
  ),
)

/** A durable repository identity and its availability on this machine. */
export class Repo extends Schema.Class<Repo>("Repo")(RepoFields) {
  /** Remote used to fetch the repository, including file URLs for local-only sources. */
  get remoteUrl(): string {
    return this.checkout.remoteUrl
  }

  /** Linked checkout path, or null when this repository is remote-only. */
  get localPath(): RepositoryCheckoutPath | null {
    return RepositoryCheckout.match(this.checkout, {
      RemoteOnly: () => null,
      LinkedCheckout: ({ path }) => path,
    })
  }

  /** Hosted locator when this repository belongs to a configured provider. */
  get hostedLocator(): HostedRepositoryLocator | null {
    return RepositorySource.match(this.source, {
      local: () => null,
      hosted: ({ locator }) => locator,
    })
  }

  /** Stable human-readable repository identity. */
  get displayIdentity(): string {
    if (Schema.is(HostedRepositorySource)(this.source)) {
      return `${this.source.locator.namespace}/${this.source.locator.name}`
    }
    if (this.id.startsWith("local:")) return this.id.slice("local:".length)
    return Schema.is(LinkedCheckout)(this.checkout)
      ? repositoryPathBasename(this.checkout.path)
      : this.id
  }

  /** Whether this repository has the supplied hosted identity. */
  matchesHosted(repository: HostedRepositoryLocator): boolean {
    return RepositorySource.match(this.source, {
      local: () => false,
      hosted: ({ locator }) => sameHostedRepository(locator, repository),
    })
  }
}

const UpsertRepositoryFields = Schema.Struct({
  ...RepositoryIdentityFields,
  favorite: RepositoryFavoriteIntent,
}).check(
  Schema.makeFilter(
    ({ source, checkout }) =>
      !Schema.is(LocalRepositorySource)(source) || Schema.is(LinkedCheckout)(checkout),
    { message: "A local repository source requires a linked checkout" },
  ),
)

/** Input for creating or updating a repository record. */
export class UpsertRepositoryInput extends Schema.Class<UpsertRepositoryInput>(
  "UpsertRepositoryInput",
)(UpsertRepositoryFields) {}

/** Builds schema-validated hosted repository persistence input. */
export const hostedRepositoryInput = (
  locator: HostedRepositoryLocator,
  checkout: RepositoryCheckout,
  favorite: RepositoryFavoriteIntent,
): UpsertRepositoryInput =>
  UpsertRepositoryInput.make({
    source: HostedRepositorySource.make({ locator }),
    checkout,
    favorite,
  })

/** Builds schema-validated local repository persistence input. */
export const localRepositoryInput = (
  checkout: LinkedCheckout,
  favorite: RepositoryFavoriteIntent,
): UpsertRepositoryInput =>
  UpsertRepositoryInput.make({
    source: LocalRepositorySource.make(),
    checkout,
    favorite,
  })

/** Builds a linked checkout while preserving file and hosted remote URL behavior. */
export const linkedRepositoryCheckout = (remoteUrl: string, path: string): LinkedCheckout =>
  LinkedCheckout.make({ remoteUrl, path: RepositoryCheckoutPath.make(path) })

/** Builds a hosted repository without a checkout on this machine. */
export const remoteOnlyRepositoryCheckout = (remoteUrl: string): RemoteOnly =>
  RemoteOnly.make({ remoteUrl })

/** A provider account or organization that can scope repository search. */
export class RepositorySearchScope extends Schema.Class<RepositorySearchScope>(
  "RepositorySearchScope",
)({
  login: Schema.String,
  kind: Schema.Literals(["user", "organization"]),
}) {}

/** Owner-scoped input for searching repositories through a Git provider. */
export class RepositorySearchRequest extends Schema.Class<RepositorySearchRequest>(
  "RepositorySearchRequest",
)({
  providerId: GitProviderId,
  query: Schema.String,
  owners: Schema.Array(Schema.String),
}) {}

/** Repository checkout metadata detected from local Git. */
export interface DetectedRepositoryCheckout {
  readonly rootPath: RepositoryCheckoutPath
  readonly remoteUrl: string
}

/** Result of one resumable repository identity repair pass. */
export class RepositoryIdentityRepairSummary extends Schema.Class<RepositoryIdentityRepairSummary>(
  "RepositoryIdentityRepairSummary",
)({
  resolvedCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  unresolvedCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  localAliasCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
}) {}

const repositoryPathBasename = (path: RepositoryCheckoutPath): string => {
  const segments = path.replace(/[\\/]+$/u, "").split(/[\\/]/u)
  return segments.at(-1) ?? path
}
