import { Effect, Option } from "effect"
import { Atom } from "effect/unstable/reactivity"

import {
  type GitProviderDescriptor,
  GitProviderId,
  HostedRepository,
} from "@diffdash/domain/git-provider"
import type { RepositorySearchScope } from "@diffdash/domain/repository"
import { type Repo } from "@diffdash/domain/repository"
import { HostedProviderRequest, HostedRepositorySearchRequest } from "@diffdash/protocol/hosted-git"
import { rendererRuntime } from "@/platform/renderer-runtime"
import { Repositories } from "@/platform/repositories"
import { makeSchemaAtomKeyCodec } from "@/shared/schema-atom-key"

const EMPTY_REPOS: readonly Repo[] = []
const EMPTY_PROVIDERS: readonly GitProviderDescriptor[] = []
const EMPTY_HOSTED_REPOSITORIES: readonly HostedRepository[] = []
const EMPTY_SEARCH_SCOPES: readonly RepositorySearchScope[] = []

const remoteSearchAtomKeyCodec = makeSchemaAtomKeyCodec(HostedRepositorySearchRequest)

/** All repositories known to the renderer. */
export const repositoriesAtom = rendererRuntime
  .atom(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.list(Option.none())
    }),
    {
      initialValue: EMPTY_REPOS,
    },
  )
  .pipe(Atom.keepAlive)

/** Registered hosted Git providers. */
export const providersAtom = rendererRuntime
  .atom(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.listProviders()
    }),
    {
      initialValue: EMPTY_PROVIDERS,
    },
  )
  .pipe(Atom.keepAlive)

/** Locally persisted repository search. */
export const repositorySearchAtom = Atom.family((query: string) =>
  rendererRuntime.atom(
    query.length === 0
      ? Effect.succeed(EMPTY_REPOS)
      : Effect.gen(function* () {
          const repositories = yield* Repositories
          return yield* repositories.list(Option.some(query))
        }),
    { initialValue: EMPTY_REPOS },
  ),
)

/** Provider-backed repository search. */
export const remoteRepositorySearchAtom = Atom.family((key: string) =>
  rendererRuntime.atom(
    Effect.gen(function* () {
      const request = key.length === 0 ? null : remoteSearchAtomKeyCodec.decode(key)
      if (request === null || request.query.length === 0) {
        return EMPTY_HOSTED_REPOSITORIES
      }
      const repositories = yield* Repositories
      return yield* repositories.searchHosted(request)
    }),
    { initialValue: EMPTY_HOSTED_REPOSITORIES },
  ),
)

/** Search scopes available for one provider. */
export const searchScopesAtom = Atom.family((providerId: string) =>
  rendererRuntime.atom(
    providerId.length === 0
      ? Effect.succeed(EMPTY_SEARCH_SCOPES)
      : Effect.gen(function* () {
          const repositories = yield* Repositories
          return yield* repositories.listSearchScopes(
            HostedProviderRequest.make({ providerId: GitProviderId.make(providerId) }),
          )
        }),
    { initialValue: EMPTY_SEARCH_SCOPES },
  ),
)

/** Stable key for provider repository search atoms. */
export const remoteSearchAtomKey = (
  providerId: GitProviderId,
  query: string,
  owners: readonly string[],
) => remoteSearchAtomKeyCodec.encode({ providerId, query, namespaces: owners })
