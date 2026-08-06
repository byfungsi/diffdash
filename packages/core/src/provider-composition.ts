import type { AgentProviderRegistration } from "@diffdash/agent-provider"
import {
  agentAutoRoutingPolicies,
  type AgentAutoRoutingPolicies,
} from "@diffdash/agent-provider/registry"
import { makeClaudeProvider } from "@diffdash/agent-provider-claude"
import { makeCodexProvider } from "@diffdash/agent-provider-codex"
import { makeFixtureAgentProvider } from "@diffdash/agent-provider-fixture"
import { makeOpenCodeProvider } from "@diffdash/agent-provider-opencode"
import type { GitProviderRegistration } from "@diffdash/git-provider"
import { createFixtureGitProvider } from "@diffdash/git-provider-fixture"
import { createGitHubProvider } from "@diffdash/git-provider-github"
import { Effect } from "effect"
import { type ProcessRunner, processRequest } from "@diffdash/process"
import type { TempResourceOperations } from "@diffdash/process/temp-resource"

/** Dependencies supplied once by the Core composition boundary. */
interface AgentProviderCompositionDependencies {
  readonly processes: ProcessRunner
  readonly tempResources: TempResourceOperations
  readonly tempDirectory: string
  readonly includeFixture: boolean
}

/** Complete agent provider composition consumed by registry and catalog services. */
interface AgentProviderComposition {
  readonly registrations: readonly AgentProviderRegistration[]
  readonly policies: AgentAutoRoutingPolicies
}

/** The only Core composition point that imports concrete agent provider packages. */
export const createAgentProviderComposition = (
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
    ...(dependencies.includeFixture ? [makeFixtureAgentProvider()] : []),
  ]
  return { registrations, policies: agentAutoRoutingPolicies(registrations) }
}

/** Creates built-in Git providers from host-decoded fixture configuration. */
export const createGitProviderComposition = (
  processes: ProcessRunner,
  fixture: {
    readonly remoteUrl: string | null
    readonly baseRevision: string | null
    readonly headRevision: string | null
  } | null,
): readonly GitProviderRegistration[] => [
  createGitHubProvider({}, processes),
  ...(fixture === null
    ? []
    : [
        createFixtureGitProvider({
          ...(fixture.remoteUrl === null ? {} : { remoteUrl: fixture.remoteUrl }),
          ...(fixture.baseRevision === null ? {} : { baseRevision: fixture.baseRevision }),
          ...(fixture.headRevision === null ? {} : { headRevision: fixture.headRevision }),
          bootstrapBareRepository: (destination) =>
            fixture.remoteUrl === null
              ? Effect.dieMessage("DIFFDASH_E2E_FAKE_GIT_REMOTE is required")
              : processes
                  .run(
                    processRequest(
                      "git",
                      ["clone", "--bare", "--", fixture.remoteUrl, destination],
                      { timeoutMs: 120_000 },
                    ),
                  )
                  .pipe(Effect.asVoid),
        }),
      ]),
]
