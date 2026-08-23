import type { AgentProviderRegistration } from "@diffdash/agent-provider"
import {
  agentAutoRoutingPolicies,
  type AgentAutoRoutingPolicies,
} from "@diffdash/agent-provider/registry"
import { makeClaudeProvider } from "@diffdash/agent-provider-claude"
import { makeCodexProvider } from "@diffdash/agent-provider-codex"
import { makeOpenCodeProvider } from "@diffdash/agent-provider-opencode"
import type { GitProviderRegistration } from "@diffdash/git-provider"
import { createGitHubProvider } from "@diffdash/git-provider-github"
import type { LanguageAdapterRegistration } from "@diffdash/language-provider"
import { typescriptLanguageAdapterRegistration } from "@diffdash/language-provider-typescript"
import type { ProcessRunner } from "@diffdash/process"
import type { TempResourceOperations } from "@diffdash/process/temp-resource"
import type { CoreAbsolutePath, CoreConfiguration } from "./core-configuration"

/** Dependencies supplied once by the Core composition boundary. */
export interface AgentProviderCompositionDependencies {
  readonly processes: ProcessRunner
  readonly tempResources: TempResourceOperations
  readonly tempDirectory: CoreAbsolutePath
}

/** Complete agent provider composition consumed by registry and catalog services. */
export interface AgentProviderComposition {
  readonly registrations: readonly AgentProviderRegistration[]
  readonly policies: AgentAutoRoutingPolicies
}

/** Concrete provider selection supplied to the Core runtime composition. */
export interface CoreProviderComposition {
  readonly createAgentProviders: (
    dependencies: AgentProviderCompositionDependencies,
    configuration: CoreConfiguration,
  ) => AgentProviderComposition
  readonly createGitProviders: (
    processes: ProcessRunner,
    configuration: CoreConfiguration,
  ) => readonly GitProviderRegistration[]
  readonly createLanguageAdapters: () => readonly LanguageAdapterRegistration[]
}

/** Creates the production agent provider set. */
export const createProductionAgentProviderComposition = (
  dependencies: AgentProviderCompositionDependencies,
): AgentProviderComposition => {
  const shared = {
    processes: dependencies.processes,
    tempResources: dependencies.tempResources,
    tempDirectory: dependencies.tempDirectory,
  }
  const registrations: readonly AgentProviderRegistration[] = [
    makeClaudeProvider(shared),
    makeCodexProvider(shared),
    makeOpenCodeProvider(shared),
  ]
  return { registrations, policies: agentAutoRoutingPolicies(registrations) }
}

/** Creates the production Git provider set. */
export const createProductionGitProviderComposition = (
  processes: ProcessRunner,
): readonly GitProviderRegistration[] => [createGitHubProvider({}, processes)]

/** Creates bundled language adapters without starting their server processes. */
export const createProductionLanguageAdapterComposition =
  (): readonly LanguageAdapterRegistration[] => [typescriptLanguageAdapterRegistration]

/** Production provider composition containing only real built-in providers. */
export const productionProviderComposition: CoreProviderComposition = {
  createAgentProviders: createProductionAgentProviderComposition,
  createGitProviders: createProductionGitProviderComposition,
  createLanguageAdapters: createProductionLanguageAdapterComposition,
}
