import { Effect, Layer } from "effect"

import {
  AUTO_AI_PROVIDER_ORDER,
  DEFAULT_AI_SETTINGS,
  type AISettings,
  type ConcreteAIProvider,
} from "../../shared/ai-settings"
import { AIAgent, type AIAgentGenerateOptions, type AIProviderAgent } from "./ai-agent"
import { AppConfig } from "./app-config"
import { AppSettings } from "./app-settings"
import { makeClaudeAgent } from "./claude-agent"
import { CliError, CliService } from "./cli"
import { makeCodexAgent } from "./codex-agent"
import { makeOpenCodeAgent } from "./opencode-agent"

/** AI agent layer that routes generation through the user-selected provider. */
export const ConfigurableAIAgent = {
  layer: Layer.effect(
    AIAgent,
    Effect.gen(function* () {
      const appConfig = yield* AppConfig
      const appSettings = yield* AppSettings
      const cli = yield* CliService

      const getSettings = appSettings.get.pipe(
        Effect.catchAll(() => Effect.succeed(DEFAULT_AI_SETTINGS)),
      )

      const providerAgent = (
        provider: ConcreteAIProvider,
        settings: AISettings,
      ): AIProviderAgent => {
        if (provider === "claude") return makeClaudeAgent(cli, settings.models.claude)
        if (provider === "opencode") {
          return makeOpenCodeAgent(cli, settings.models.opencode, appConfig.tempDir)
        }
        return makeCodexAgent(cli, settings.models.codex, appConfig.tempDir)
      }

      const generateWithProvider = (
        provider: ConcreteAIProvider,
        settings: AISettings,
        prompt: string,
        options: AIAgentGenerateOptions | undefined,
      ): Effect.Effect<string, CliError> =>
        providerAgent(provider, settings).generateText(prompt, options)

      const generateWithFallback = (
        settings: AISettings,
        prompt: string,
        options: AIAgentGenerateOptions | undefined,
        providerIndex = 0,
      ): Effect.Effect<string, CliError> => {
        const provider = AUTO_AI_PROVIDER_ORDER[providerIndex]
        if (provider === undefined)
          return makeCodexAgent(cli, settings.models.codex, appConfig.tempDir).generateText(
            prompt,
            options,
          )

        return generateWithProvider(provider, settings, prompt, options).pipe(
          Effect.catchAll((error) => {
            if (providerIndex >= AUTO_AI_PROVIDER_ORDER.length - 1) return Effect.fail(error)
            return generateWithFallback(settings, prompt, options, providerIndex + 1)
          }),
        )
      }

      const isProviderAvailable = (
        provider: ConcreteAIProvider,
        settings: AISettings,
      ): Effect.Effect<boolean> => providerAgent(provider, settings).isAvailable

      const anyProviderAvailable = (
        settings: AISettings,
        providerIndex = 0,
      ): Effect.Effect<boolean> => {
        const provider = AUTO_AI_PROVIDER_ORDER[providerIndex]
        if (provider === undefined) return Effect.succeed(false)

        return isProviderAvailable(provider, settings).pipe(
          Effect.flatMap((available) => {
            if (available) return Effect.succeed(true)
            return anyProviderAvailable(settings, providerIndex + 1)
          }),
        )
      }

      return AIAgent.of({
        generateText: Effect.fn("ConfigurableAIAgent.generateText")(function (prompt, options) {
          return getSettings.pipe(
            Effect.flatMap((settings) => {
              if (settings.provider === "auto")
                return generateWithFallback(settings, prompt, options)
              return generateWithProvider(settings.provider, settings, prompt, options)
            }),
          )
        }),
        isAvailable: getSettings.pipe(
          Effect.flatMap((settings) => {
            if (settings.provider === "auto") return anyProviderAvailable(settings)
            return isProviderAvailable(settings.provider, settings)
          }),
        ),
      })
    }),
  ),
}
