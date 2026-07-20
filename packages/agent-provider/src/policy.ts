import { AgentExecutionPolicy, type McpToolName } from "./agent-provider"

/** Provider-visible choices that vary within DiffDash's non-mutating execution policy. */
export interface NonMutatingAgentExecutionPolicyOptions {
  readonly network: AgentExecutionPolicy["network"]
  readonly repository: AgentExecutionPolicy["repository"]
  readonly shell: AgentExecutionPolicy["shell"]
  readonly providerPublishingTools?: readonly string[]
  readonly allowedMcpTools?: readonly McpToolName[]
}

/** Constructs an execution policy with every mutation and sensitive-file capability denied. */
export const makeNonMutatingAgentExecutionPolicy = (
  options: NonMutatingAgentExecutionPolicyOptions,
) =>
  AgentExecutionPolicy.make({
    network: options.network,
    sensitiveFiles: "deny",
    repository: options.repository,
    shell: options.shell,
    fileMutation: "deny",
    gitMutation: "deny",
    providerPublishing: "deny",
    providerPublishingTools: [...(options.providerPublishingTools ?? [])],
    allowedMcpTools: [...(options.allowedMcpTools ?? [])],
  })

/** Returns whether a policy preserves DiffDash's non-mutation and sensitive-file invariants. */
export const isNonMutatingAgentExecutionPolicy = (policy: AgentExecutionPolicy): boolean =>
  policy.sensitiveFiles === "deny" &&
  policy.fileMutation === "deny" &&
  policy.gitMutation === "deny" &&
  policy.providerPublishing === "deny"
