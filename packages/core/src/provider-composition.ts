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
import { Effect, Option } from "effect"
import { type ProcessRunner, processRequest } from "@diffdash/process"
import type { TempResourceOperations } from "@diffdash/process/temp-resource"

/** Dependencies supplied once by the Core composition boundary. */
interface AgentProviderCompositionBaseDependencies {
  readonly processes: ProcessRunner
  readonly tempResources: TempResourceOperations
  readonly tempDirectory: string
}

type AgentProviderCompositionDependencies = AgentProviderCompositionBaseDependencies & {
  readonly fixture: Option.Option<{
    readonly walkthroughNeverCompletes: boolean
  }>
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
  const fixture = dependencies.fixture
  const shared = {
    processes: dependencies.processes,
    tempResources: dependencies.tempResources,
    tempDirectory: dependencies.tempDirectory,
  }
  const registrations: readonly AgentProviderRegistration[] = [
    makeClaudeProvider(shared),
    makeCodexProvider(shared),
    makeOpenCodeProvider(shared),
    ...(Option.isSome(fixture)
      ? [
          makeFixtureAgentProvider({
            walkthroughNeverCompletes: fixture.value.walkthroughNeverCompletes,
          }),
        ]
      : []),
  ]
  return { registrations, policies: agentAutoRoutingPolicies(registrations) }
}

/** Creates built-in Git providers from host-decoded fixture configuration. */
export const createGitProviderComposition = (
  processes: ProcessRunner,
  configuredFixture: Option.Option<{
    readonly remoteUrl: string
    readonly baseRevision: Option.Option<string>
    readonly headRevision: Option.Option<string>
  }>,
): readonly GitProviderRegistration[] => {
  return [
    createGitHubProvider({}, processes),
    ...(Option.isNone(configuredFixture)
      ? []
      : [
          createFixtureGitProvider({
            remoteUrl: configuredFixture.value.remoteUrl,
            ...(Option.isNone(configuredFixture.value.baseRevision)
              ? {}
              : { baseRevision: configuredFixture.value.baseRevision.value }),
            ...(Option.isNone(configuredFixture.value.headRevision)
              ? {}
              : { headRevision: configuredFixture.value.headRevision.value }),
            bootstrapBareRepository: (destination) =>
              processes
                .run(
                  processRequest(
                    "git",
                    ["clone", "--bare", "--", configuredFixture.value.remoteUrl, destination],
                    {
                      timeoutMs: 120_000,
                    },
                  ),
                )
                .pipe(Effect.asVoid),
          }),
        ]),
  ]
}
