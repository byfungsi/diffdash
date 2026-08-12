import { agentAutoRoutingPolicies } from "@diffdash/agent-provider/registry"
import { makeFixtureAgentProvider } from "@diffdash/agent-provider-fixture"
import {
  createFixtureGitProvider,
  type FixtureGitProviderConfig,
} from "@diffdash/git-provider-fixture"
import { Effect, Option } from "effect"
import { type ProcessRunner, processRequest } from "@diffdash/process"
import type { ReviewRevision } from "@diffdash/domain/review-identity"
import type { GitProviderRegistration } from "@diffdash/git-provider"
import type { GitFixtureRemote } from "./core-configuration"
import {
  type AgentProviderComposition,
  type AgentProviderCompositionDependencies,
  type CoreProviderComposition,
  createProductionAgentProviderComposition,
  createProductionGitProviderComposition,
} from "./provider-composition"

/** Creates real and fixture agent providers for the E2E runtime. */
export const createAgentProviderComposition = (
  dependencies: AgentProviderCompositionDependencies & {
    readonly fixture: Option.Option<{ readonly walkthroughNeverCompletes: boolean }>
  },
): AgentProviderComposition => {
  const production = createProductionAgentProviderComposition(dependencies)
  const registrations = [...production.registrations]
  if (Option.isSome(dependencies.fixture)) {
    registrations.push(
      makeFixtureAgentProvider({
        walkthroughNeverCompletes: dependencies.fixture.value.walkthroughNeverCompletes,
      }),
    )
  }
  return { registrations, policies: agentAutoRoutingPolicies(registrations) }
}

/** Creates real and fixture Git providers for the E2E runtime. */
export const createGitProviderComposition = (
  processes: ProcessRunner,
  fixture: Option.Option<{
    readonly remoteUrl: GitFixtureRemote
    readonly baseRevision: Option.Option<ReviewRevision>
    readonly headRevision: Option.Option<ReviewRevision>
  }>,
): readonly GitProviderRegistration[] => {
  const production = createProductionGitProviderComposition(processes)
  if (Option.isNone(fixture)) return production
  const bootstrapBareRepository: FixtureGitProviderConfig["bootstrapBareRepository"] = (
    destination,
  ) =>
    processes
      .run(
        processRequest("git", ["clone", "--bare", "--", fixture.value.remoteUrl, destination], {
          timeoutMs: 120_000,
        }),
      )
      .pipe(Effect.asVoid)
  const baseRevision = Option.isNone(fixture.value.baseRevision)
    ? {}
    : { baseRevision: fixture.value.baseRevision.value }
  const headRevision = Option.isNone(fixture.value.headRevision)
    ? {}
    : { headRevision: fixture.value.headRevision.value }
  return [
    ...production,
    createFixtureGitProvider({
      remoteUrl: fixture.value.remoteUrl,
      ...baseRevision,
      ...headRevision,
      bootstrapBareRepository,
    }),
  ]
}

/** E2E provider composition extending production providers with deterministic fixtures. */
export const e2eProviderComposition: CoreProviderComposition = {
  createAgentProviders: (dependencies, configuration) =>
    createAgentProviderComposition({
      ...dependencies,
      fixture: configuration.fixtures.agentProvider,
    }),
  createGitProviders: (processes, configuration) =>
    createGitProviderComposition(processes, configuration.fixtures.gitProviderOption),
}
