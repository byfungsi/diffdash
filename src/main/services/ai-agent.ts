import { Context, Effect } from "effect"

import { CliError, type CliResult } from "./cli"

/** Provider-neutral reasoning effort hint for generation requests. */
export type AIAgentReasoningEffort = "minimal" | "low" | "medium" | "high"

/** Options for a single AI agent text generation request. */
export interface AIAgentGenerateOptions {
  readonly timeoutMs?: number
  readonly reasoningEffort?: AIAgentReasoningEffort
}

/** Concrete provider implementation used by configurable AI routing. */
export interface AIProviderAgent {
  readonly generateText: (
    prompt: string,
    options?: AIAgentGenerateOptions,
  ) => Effect.Effect<string, CliError>
  readonly isAvailable: Effect.Effect<boolean>
}

/** Provider-neutral AI agent used by app services. */
export class AIAgent extends Context.Tag("@diffdash/AIAgent")<AIAgent, AIProviderAgent>() {}

/** Fails successful CLI invocations that did not produce generated text. */
export const requireGeneratedText = (
  result: CliResult,
  provider: string,
  output: string,
): Effect.Effect<string, CliError> => {
  if (output.trim().length > 0) return Effect.succeed(output)

  const stderr = result.stderr.trim()
  return Effect.fail(
    CliError.make({
      command: result.command,
      args: [...result.args],
      cwd: result.cwd,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr:
        stderr.length > 0
          ? `${provider} completed without output.\n${stderr}`
          : `${provider} completed without output.`,
      cause: null,
    }),
  )
}
