import { Effect, Layer } from "effect"

import {
  AUTO_AI_PROVIDER_ORDER,
  autoQualityProviderModels,
  type BuiltInAIProvider,
  DEFAULT_BUILT_IN_MODELS,
  DEFAULT_AI_SETTINGS,
  type AISettings,
} from "@diffdash/domain/ai-settings"
import { CODEX_AUTO_MODELS, CODEX_DEFAULT_MODEL } from "@diffdash/agent-provider-codex"
import { OPENCODE_AUTO_MODELS, OPENCODE_DEFAULT_MODEL } from "@diffdash/agent-provider-opencode"
import { AIAgent, type AIAgentGenerateOptions, type AIProviderAgent } from "./ai-agent"
import { AppConfig } from "./app-config"
import { AppSettings } from "@diffdash/settings/app-settings"
import { makeClaudeAgent } from "./claude-agent"
import { CliError, CliService } from "@diffdash/process/cli"
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
        provider: BuiltInAIProvider,
        settings: AISettings,
      ): AIProviderAgent => {
        const model =
          settings.models[provider] ??
          (provider === "codex"
            ? CODEX_DEFAULT_MODEL
            : provider === "opencode"
              ? OPENCODE_DEFAULT_MODEL
              : DEFAULT_BUILT_IN_MODELS[provider])
        if (provider === "claude") return makeClaudeAgent(cli, model)
        if (provider === "opencode") {
          return makeOpenCodeAgent(cli, model, appConfig.tempDir)
        }
        return makeCodexAgent(cli, model, appConfig.tempDir)
      }

      const generateWithProvider = (
        provider: BuiltInAIProvider,
        settings: AISettings,
        prompt: string,
        options: AIAgentGenerateOptions | undefined,
      ): Effect.Effect<string, CliError> =>
        providerAgent(provider, settings).generateText(prompt, options)

      const generateWithFallback = (
        settings: AISettings,
        prompt: string,
        options: AIAgentGenerateOptions | undefined,
        agentIndex = 0,
      ): Effect.Effect<string, CliError> => {
        const agent = autoProviderAgents(settings)[agentIndex]
        if (agent === undefined)
          return makeCodexAgent(
            cli,
            settings.models.codex ?? CODEX_DEFAULT_MODEL,
            appConfig.tempDir,
          ).generateText(prompt, options)

        return agent.generateText(prompt, options).pipe(
          Effect.catchAll((error) => {
            if (agentIndex >= autoProviderAgents(settings).length - 1) return Effect.fail(error)
            return generateWithFallback(settings, prompt, options, agentIndex + 1)
          }),
        )
      }

      const autoProviderAgents = (settings: AISettings): readonly AIProviderAgent[] => {
        const models = autoQualityProviderModels(settings.autoQuality)
        return [
          makeClaudeAgent(cli, models.claude),
          makeCodexAgent(cli, CODEX_AUTO_MODELS[settings.autoQuality], appConfig.tempDir),
          makeOpenCodeAgent(cli, OPENCODE_AUTO_MODELS[settings.autoQuality][0], appConfig.tempDir),
          makeOpenCodeAgent(cli, OPENCODE_AUTO_MODELS[settings.autoQuality][1], appConfig.tempDir),
        ]
      }

      const isProviderAvailable = (
        provider: BuiltInAIProvider,
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
              const route = settings.routes.walkthrough
              if (route === "auto") return generateWithFallback(settings, prompt, options)
              if (!isBuiltInProvider(route)) return Effect.fail(unknownProviderError(route))
              return generateWithProvider(route, settings, prompt, options)
            }),
          )
        }),
        isAvailable: getSettings.pipe(
          Effect.flatMap((settings) => {
            const route = settings.routes.walkthrough
            if (route === "auto") return anyProviderAvailable(settings)
            return isBuiltInProvider(route)
              ? isProviderAvailable(route, settings)
              : Effect.succeed(false)
          }),
        ),
      })
    }),
  ),
}

const isBuiltInProvider = (provider: string): provider is BuiltInAIProvider =>
  provider === "claude" || provider === "codex" || provider === "opencode"

const unknownProviderError = (provider: string) =>
  CliError.make({
    command: provider,
    args: [],
    cwd: null,
    exitCode: null,
    stderr: "",
    cause: null,
  })
