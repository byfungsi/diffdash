import { Atom } from "@effect-atom/atom-react"
import { Effect } from "effect"

import {
  type GitProviderDescriptor,
  GitProviderId,
  type HostedRepository,
} from "@diffdash/domain/git-provider"
import type { RepositorySearchScope } from "@diffdash/domain/repository"
import { type Repo } from "@diffdash/domain/repository"
import { HostedProviderRequest, HostedRepositorySearchRequest } from "@diffdash/protocol/hosted-git"
import { fetchEffect } from "@/shared/effect-api"
import { makeSchemaAtomKeyCodec } from "@/shared/schema-atom-key"

const remoteSearchAtomKeyCodec = makeSchemaAtomKeyCodec(HostedRepositorySearchRequest)

/** All repositories known to the renderer. */
export const repositoriesAtom = Atom.make(
  fetchEffect(() => window.diffDash.repositories.list()),
  {
    initialValue: [] as readonly Repo[],
  },
).pipe(Atom.keepAlive)

/** Registered hosted Git providers. */
export const providersAtom = Atom.make(
  fetchEffect(() => window.diffDash.providers.list()),
  {
    initialValue: [] as readonly GitProviderDescriptor[],
  },
).pipe(Atom.keepAlive)

/** Whether a repository belongs in the hosted-review bookmark list. */
export const isBookmarkedPullRequestRepo = (repo: Repo) =>
  repo.provider !== "local" && repo.isFavorite

/** Locally persisted repository search. */
export const repositorySearchAtom = Atom.family((query: string) =>
  Atom.make(
    query.length === 0
      ? Effect.succeed([] as readonly Repo[])
      : fetchEffect(() => window.diffDash.repositories.list(query)).pipe(
          Effect.map((repos) => repos.filter(isBookmarkedPullRequestRepo)),
        ),
    { initialValue: [] as readonly Repo[] },
  ),
)

/** Provider-backed repository search. */
export const remoteRepositorySearchAtom = Atom.family((key: string) =>
  Atom.make(
    Effect.gen(function* () {
      const request = parseRemoteSearchAtomKey(key)
      if (request === null || request.query.length === 0 || request.namespaces.length === 0) {
        return [] as readonly HostedRepository[]
      }
      return yield* fetchEffect(() =>
        window.diffDash.hostedRepositories.searchRepositories(request),
      )
    }),
    { initialValue: [] as readonly HostedRepository[] },
  ),
)

/** Search scopes available for one provider. */
export const searchScopesAtom = Atom.family((providerId: string) =>
  Atom.make(
    providerId.length === 0
      ? Effect.succeed([] as readonly RepositorySearchScope[])
      : fetchEffect(() =>
          window.diffDash.hostedRepositories.listSearchScopes(
            HostedProviderRequest.make({ providerId: GitProviderId.make(providerId) }),
          ),
        ),
    { initialValue: [] as readonly RepositorySearchScope[] },
  ),
)

/** Applies the selected owner scope to local bookmark search. */
export const scopedLocalSearchQuery = (query: string, scope: string | null) =>
  scope === null ? query : `${scope}/${query}`

/** Stable key for provider repository search atoms. */
export const remoteSearchAtomKey = (
  providerId: GitProviderId,
  query: string,
  owners: readonly string[],
) => remoteSearchAtomKeyCodec.encode({ providerId, query, namespaces: owners })

const parseRemoteSearchAtomKey = remoteSearchAtomKeyCodec.decode
