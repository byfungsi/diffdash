import type { AgentProviderRegistration } from "@diffdash/agent-provider"
import {
  agentAutoRoutingPolicies,
  type AgentAutoRoutingPolicies,
} from "@diffdash/agent-provider/registry"
import { makeClaudeProvider } from "@diffdash/agent-provider-claude"
import { makeCodexProvider } from "@diffdash/agent-provider-codex"
import { makeFixtureAgentProvider } from "@diffdash/agent-provider-fixture"
import { makeOpenCodeProvider } from "@diffdash/agent-provider-opencode"
import type { ProcessRunner } from "@diffdash/process"

/** Dependencies supplied once by the desktop application boundary. */
interface AgentProviderCompositionDependencies {
  readonly processes: ProcessRunner
  readonly tempDirectory: string
  readonly includeFixture: boolean
}

/** Complete agent provider composition consumed by registry and catalog services. */
interface AgentProviderComposition {
  readonly registrations: readonly AgentProviderRegistration[]
  readonly policies: AgentAutoRoutingPolicies
}

/** The only desktop composition point that imports concrete agent provider packages. */
export const createAgentProviderComposition = (
  dependencies: AgentProviderCompositionDependencies,
): AgentProviderComposition => {
  const shared = {
    processes: dependencies.processes,
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
