import { Atom } from "@effect-atom/atom-react"
import { Effect, Option } from "effect"

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

const remoteSearchAtomKeyCodec = makeSchemaAtomKeyCodec(HostedRepositorySearchRequest)

/** All repositories known to the renderer. */
export const repositoriesAtom = rendererRuntime
  .atom(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.list(Option.none())
    }),
    {
      initialValue: [] as readonly Repo[],
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
      initialValue: [] as readonly GitProviderDescriptor[],
    },
  )
  .pipe(Atom.keepAlive)

/** Locally persisted repository search. */
export const repositorySearchAtom = Atom.family((query: string) =>
  rendererRuntime.atom(
    query.length === 0
      ? Effect.succeed([] as readonly Repo[])
      : Effect.gen(function* () {
          const repositories = yield* Repositories
          return yield* repositories.list(Option.some(query))
        }),
    { initialValue: [] as readonly Repo[] },
  ),
)

/** Provider-backed repository search. */
export const remoteRepositorySearchAtom = Atom.family((key: string) =>
  rendererRuntime.atom(
    Effect.gen(function* () {
      const request = parseRemoteSearchAtomKey(key)
      if (request === null || request.query.length === 0) {
        return [] as readonly HostedRepository[]
      }
      const repositories = yield* Repositories
      return yield* repositories.searchHosted(request)
    }),
    { initialValue: [] as readonly HostedRepository[] },
  ),
)

/** Search scopes available for one provider. */
export const searchScopesAtom = Atom.family((providerId: string) =>
  rendererRuntime.atom(
    providerId.length === 0
      ? Effect.succeed([] as readonly RepositorySearchScope[])
      : Effect.gen(function* () {
          const repositories = yield* Repositories
          return yield* repositories.listSearchScopes(
            HostedProviderRequest.make({ providerId: GitProviderId.make(providerId) }),
          )
        }),
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
