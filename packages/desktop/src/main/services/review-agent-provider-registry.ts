import { Context, Effect, Layer, Schema } from "effect"

import {
  AUTO_AI_PROVIDER_ORDER,
  type AICapabilityRoute,
  type BuiltInAIProvider,
} from "@diffdash/domain/ai-settings"
import type { ReviewAgentProviderId } from "@diffdash/domain/review-agent"
import { AgentArtifactNormalizer } from "./agent-artifact-normalizer"
import { claudeReviewAgentLayer } from "./claude-review-agent"
import { CliStreamService } from "@diffdash/process/cli-stream"
import { codexReviewAgentLayer } from "./codex-review-agent"
import { openCodeReviewAgentLayer } from "./opencode-review-agent"
import { OpenCodeSdkClient } from "./opencode-sdk-client"
import { ReviewAgentProvider } from "./review-agent-provider"

type ProviderService = Context.Tag.Service<ReviewAgentProvider>

/** No configured local review provider is available for an agent turn. */
export class ReviewAgentProviderUnavailableError extends Schema.TaggedError<ReviewAgentProviderUnavailableError>()(
  "ReviewAgentProviderUnavailableError",
  {
    requestedProvider: Schema.String,
    reason: Schema.String,
  },
) {}

/** Built-once registry for selecting one of the local review-agent adapters. */
export class ReviewAgentProviderRegistry extends Context.Tag(
  "@diffdash/ReviewAgentProviderRegistry",
)<
  ReviewAgentProviderRegistry,
  {
    readonly get: (
      provider: ReviewAgentProviderId,
    ) => Effect.Effect<ProviderService, ReviewAgentProviderUnavailableError>
    readonly resolve: (
      provider: AICapabilityRoute,
    ) => Effect.Effect<ProviderService, ReviewAgentProviderUnavailableError>
  }
>() {
  static readonly layer = Layer.scoped(
    ReviewAgentProviderRegistry,
    Effect.gen(function* () {
      const sdk = yield* OpenCodeSdkClient
      const cli = yield* CliStreamService
      const normalizer = yield* AgentArtifactNormalizer
      const shared = Layer.mergeAll(
        Layer.succeed(OpenCodeSdkClient, sdk),
        Layer.succeed(CliStreamService, cli),
        Layer.succeed(AgentArtifactNormalizer, normalizer),
      )
      const providers = new Map<ReviewAgentProviderId, ProviderService>()
      const built = yield* Effect.all([
        Layer.build(openCodeReviewAgentLayer.pipe(Layer.provide(shared))),
        Layer.build(codexReviewAgentLayer.pipe(Layer.provide(shared))),
        Layer.build(claudeReviewAgentLayer.pipe(Layer.provide(shared))),
      ])
      for (const services of built) {
        const provider = Context.get(services, ReviewAgentProvider)
        providers.set(provider.id, provider)
      }

      const get = (
        provider: ReviewAgentProviderId,
      ): Effect.Effect<ProviderService, ReviewAgentProviderUnavailableError> => {
        const service = providers.get(provider)
        return service === undefined
          ? Effect.fail(
              ReviewAgentProviderUnavailableError.make({
                requestedProvider: provider,
                reason: `Review agent provider is not registered: ${provider}`,
              }),
            )
          : Effect.succeed(service)
      }
      const requireAvailable = (provider: ReviewAgentProviderId) =>
        get(provider).pipe(
          Effect.flatMap((service) =>
            service.isAvailable.pipe(
              Effect.mapError((cause) =>
                ReviewAgentProviderUnavailableError.make({
                  requestedProvider: provider,
                  reason: cause.message,
                }),
              ),
              Effect.flatMap((available) =>
                available
                  ? Effect.succeed(service)
                  : Effect.fail(
                      ReviewAgentProviderUnavailableError.make({
                        requestedProvider: provider,
                        reason: `${provider} is not installed or available`,
                      }),
                    ),
              ),
            ),
          ),
        )

      return ReviewAgentProviderRegistry.of({
        get,
        resolve: (provider) =>
          provider === "auto"
            ? resolveFirstAvailable(AUTO_AI_PROVIDER_ORDER, requireAvailable)
            : requireAvailable(provider),
      })
    }),
  )
}

const resolveFirstAvailable = (
  providers: readonly BuiltInAIProvider[],
  resolve: (
    provider: ReviewAgentProviderId,
  ) => Effect.Effect<ProviderService, ReviewAgentProviderUnavailableError>,
): Effect.Effect<ProviderService, ReviewAgentProviderUnavailableError> => {
  const [provider, ...remaining] = providers
  if (provider === undefined) {
    return Effect.fail(
      ReviewAgentProviderUnavailableError.make({
        requestedProvider: "auto",
        reason: "No supported local review agent is available",
      }),
    )
  }
  return resolve(provider).pipe(
    Effect.catchTag("ReviewAgentProviderUnavailableError", () =>
      resolveFirstAvailable(remaining, resolve),
    ),
  )
}
