import type { AgentProviderRegistration } from "@diffdash/agent-provider"
import {
  agentAutoRoutingPolicies,
  type AgentAutoRoutingPolicies,
} from "@diffdash/agent-provider/registry"
import { makeClaudeProvider } from "@diffdash/agent-provider-claude"
import { makeCodexProvider } from "@diffdash/agent-provider-codex"
import { makeFixtureAgentProvider } from "@diffdash/agent-provider-fixture"
import { makeOpenCodeProvider } from "@diffdash/agent-provider-opencode"
import type { CliRunner } from "@diffdash/process/cli"
import type { CliStreamRunner } from "@diffdash/process/cli-stream"

/** Dependencies supplied once by the desktop application boundary. */
export interface AgentProviderCompositionDependencies {
  readonly cli: CliRunner
  readonly cliStream: CliStreamRunner
  readonly tempDirectory: string
  readonly includeFixture: boolean
}

/** Complete agent provider composition consumed by registry and catalog services. */
export interface AgentProviderComposition {
  readonly registrations: readonly AgentProviderRegistration[]
  readonly policies: AgentAutoRoutingPolicies
}

/** The only desktop composition point that imports concrete agent provider packages. */
export const createAgentProviderComposition = (
  dependencies: AgentProviderCompositionDependencies,
): AgentProviderComposition => {
  const shared = {
    cli: dependencies.cli,
    cliStream: dependencies.cliStream,
    tempDirectory: dependencies.tempDirectory,
  }
  const registrations: readonly AgentProviderRegistration[] = [
    makeClaudeProvider(shared),
    makeCodexProvider(shared),
    makeOpenCodeProvider(shared),
    ...(dependencies.includeFixture ? [makeFixtureAgentProvider()] : []),
  ]
  return { registrations, policies: agentAutoRoutingPolicies(registrations) }
}
