import { Context, Effect, Layer } from "effect"

import { GitProviderId, type HostedRepositoryLocator } from "@diffdash/domain/git-provider"
import {
  AmbiguousGitRemoteError,
  DuplicateGitProviderError,
  type GitProviderOperationError,
  type GitProviderRegistration,
  UnknownGitProviderError,
} from "./git-provider"

/** Registry of configured hosted Git provider instances. */
export class GitProviderRegistry extends Context.Tag("@diffdash/GitProviderRegistry")<
  GitProviderRegistry,
  {
    readonly list: Effect.Effect<readonly GitProviderRegistration[]>
    readonly get: (
      providerId: GitProviderId,
    ) => Effect.Effect<GitProviderRegistration, UnknownGitProviderError>
    readonly resolveRemote: (
      remoteUrl: string,
    ) => Effect.Effect<
      HostedRepositoryLocator | null,
      AmbiguousGitRemoteError | GitProviderOperationError
    >
  }
>() {
  /** Builds a registry and fails immediately when instance IDs collide. */
  static readonly layer = (registrations: readonly GitProviderRegistration[]) =>
    Layer.effect(
      GitProviderRegistry,
      Effect.gen(function* () {
        const providers = new Map<GitProviderId, GitProviderRegistration>()
        for (const registration of registrations) {
          if (providers.has(registration.descriptor.id)) {
            return yield* DuplicateGitProviderError.make({
              providerId: registration.descriptor.id,
            })
          }
          providers.set(registration.descriptor.id, registration)
        }

        return GitProviderRegistry.of({
          list: Effect.succeed([...providers.values()]),
          get: (providerId) =>
            Effect.fromNullable(providers.get(providerId)).pipe(
              Effect.orElseFail(() => UnknownGitProviderError.make({ providerId })),
            ),
          resolveRemote: Effect.fn("GitProviderRegistry.resolveRemote")(function* (remoteUrl) {
            const matches = (yield* Effect.all(
              [...providers.values()].map((provider) => provider.parseRemote(remoteUrl)),
              { concurrency: "unbounded" },
            )).filter((match): match is HostedRepositoryLocator => match !== null)
            if (matches.length > 1) {
              return yield* AmbiguousGitRemoteError.make({
                remoteUrl,
                providerIds: matches.map(({ providerId }) => providerId),
              })
            }
            return matches[0] ?? null
          }),
        })
      }),
    )
}
