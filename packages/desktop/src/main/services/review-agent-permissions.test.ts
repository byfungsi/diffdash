import { describe, expect, it } from "@effect/vitest"

import { THREAD_MODE_REVIEW_AGENT_PERMISSIONS } from "@diffdash/domain/review-agent"
import { resolveReviewAgentPermissionConfig } from "./review-agent-permissions"

describe("review agent permission configuration", () => {
  it("FUN-75 AC: OpenCode denies mutation and shell while allowing native reads", () => {
    const result = resolveReviewAgentPermissionConfig(THREAD_MODE_REVIEW_AGENT_PERMISSIONS, {
      provider: "opencode",
      toolPermissions: true,
    })

    expect(result.enabled).toBe(true)
    if (!result.enabled || result.config.provider !== "opencode") return
    expect(result.config.sdkConfig.permission).toMatchObject({
      "*": "deny",
      read: {
        "*": "allow",
        "*.env": "deny",
        "*.env.*": "deny",
        "*.env.example": "allow",
      },
      glob: "allow",
      grep: "allow",
      edit: "deny",
      bash: "deny",
      external_directory: "deny",
    })
    expect(result.config.sdkConfig.permission).not.toHaveProperty("github")
    expect(result.config.sdkConfig.permission.edit).toBe("deny")
    expect(result.config.sdkConfig.permission.bash).toBe("deny")
    expect(JSON.stringify(result.config)).not.toContain("git status")
  })

  it("FUN-75 AC: Claude uses an exact read-only tool allowlist and explicit denials", () => {
    const result = resolveReviewAgentPermissionConfig(THREAD_MODE_REVIEW_AGENT_PERMISSIONS, {
      provider: "claude",
      exactToolAllowlist: true,
      nonInteractivePermissionMode: true,
    })

    expect(result.enabled).toBe(true)
    if (!result.enabled || result.config.provider !== "claude") return
    expect(result.config.allowedTools).toContain("Read")
    expect(result.config.allowedTools).toContain("mcp__diffdash__getDiffHunk")
    expect(result.config.allowedTools).toContain("mcp__diffdash__searchReviewDiff")
    expect(result.config.allowedTools).toContain("mcp__diffdash__searchRepository")
    expect(result.config.allowedTools).toContain("mcp__diffdash__readRepositoryFile")
    expect(result.config.allowedTools).not.toContain("Bash")
    expect(result.config.allowedTools).not.toContain("Edit")
    expect(result.config.allowedTools.some((tool) => tool.startsWith("mcp__github__"))).toBe(false)
    expect(result.config.availableTools).not.toContain("Bash")
    expect(result.config.availableTools).not.toContain("Edit")
    expect(result.config.availableTools).not.toContain("Write")
    expect(result.config.deniedTools).toContain("Edit")
    expect(result.config.deniedTools).toContain("Write")
    expect(result.config.deniedTools).toContain("Bash(git commit*)")
    expect(result.config.deniedTools).toContain("Bash(git push*)")
    expect(result.config.deniedTools).toContain("Bash(pnpm install*)")
    expect(result.config.deniedTools).toContain("Bash(pnpm format*)")
    expect(result.config.deniedTools).toContain("Bash(gh pr comment*)")
    expect(result.config.cliArgs).toContain("dontAsk")
    expect(result.config.cliArgs).toContain("--strict-mcp-config")
  })

  it("FUN-75 AC: Codex uses read-only sandboxing with noninteractive denial", () => {
    const result = resolveReviewAgentPermissionConfig(THREAD_MODE_REVIEW_AGENT_PERMISSIONS, {
      provider: "codex",
      readOnlySandbox: true,
      nonInteractiveApprovalPolicy: true,
    })

    expect(result.enabled).toBe(true)
    if (!result.enabled || result.config.provider !== "codex") return
    expect(result.config.cliArgs).toEqual([
      "--ask-for-approval",
      "never",
      "--sandbox",
      "read-only",
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
    ])
    expect(result.config.cliArgs.indexOf("--ask-for-approval")).toBeLessThan(
      result.config.cliArgs.indexOf("exec"),
    )
    expect(result.config.cliArgs).not.toContain("--dangerously-bypass-approvals-and-sandbox")
  })

  it("FUN-75 AC: fails closed when any provider-native control is insufficient", () => {
    const results = [
      resolveReviewAgentPermissionConfig(THREAD_MODE_REVIEW_AGENT_PERMISSIONS, {
        provider: "opencode",
        toolPermissions: false,
      }),
      resolveReviewAgentPermissionConfig(THREAD_MODE_REVIEW_AGENT_PERMISSIONS, {
        provider: "claude",
        exactToolAllowlist: false,
        nonInteractivePermissionMode: true,
      }),
      resolveReviewAgentPermissionConfig(THREAD_MODE_REVIEW_AGENT_PERMISSIONS, {
        provider: "codex",
        readOnlySandbox: true,
        nonInteractiveApprovalPolicy: false,
      }),
    ]

    expect(results.every((result) => !result.enabled)).toBe(true)
    for (const result of results) {
      expect(result).not.toHaveProperty("config")
      if (result.enabled) throw new Error("Expected provider tool mode to be disabled")
      expect(result.reason.length).toBeGreaterThan(0)
    }
  })
})
