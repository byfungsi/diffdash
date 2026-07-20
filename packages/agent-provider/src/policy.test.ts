import { describe, expect, it } from "@effect/vitest"

import { McpToolName } from "./agent-provider"
import { isNonMutatingAgentExecutionPolicy, makeNonMutatingAgentExecutionPolicy } from "./policy"

describe("agent execution policy", () => {
  it("constructs non-mutating policies without hiding provider-visible choices", () => {
    const allowedTool = McpToolName.make("getDiffHunk")
    const policy = makeNonMutatingAgentExecutionPolicy({
      network: "allow",
      repository: "reviewed-revision",
      shell: "read-only",
      providerPublishingTools: ["publish_review"],
      allowedMcpTools: [allowedTool],
    })

    expect(policy).toMatchObject({
      network: "allow",
      repository: "reviewed-revision",
      shell: "read-only",
      sensitiveFiles: "deny",
      fileMutation: "deny",
      gitMutation: "deny",
      providerPublishing: "deny",
      providerPublishingTools: ["publish_review"],
      allowedMcpTools: [allowedTool],
    })
    expect(isNonMutatingAgentExecutionPolicy(policy)).toBe(true)
  })
})
