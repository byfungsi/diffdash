import type { ReviewAgentPermissions, ReviewAgentProviderId } from "../../shared/review-agent"

const DIFFDASH_MCP_TOOLS = [
  "getReviewContext",
  "getChangedFiles",
  "searchReviewDiff",
  "getDiffHunk",
  "getDiffFile",
  "searchRepository",
  "readRepositoryFile",
  "getThreadContext",
  "getOlderThreadMessages",
  "getPriorArtifact",
  "getWalkthroughContext",
] as const

const CLAUDE_BUILT_IN_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"] as const

const CLAUDE_DENIED_TOOLS = [
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash(git add*)",
  "Bash(git branch*)",
  "Bash(git checkout*)",
  "Bash(git cherry-pick*)",
  "Bash(git clean*)",
  "Bash(git commit*)",
  "Bash(git merge*)",
  "Bash(git mv*)",
  "Bash(git push*)",
  "Bash(git rebase*)",
  "Bash(git remote add*)",
  "Bash(git remote set-url*)",
  "Bash(git reset*)",
  "Bash(git restore*)",
  "Bash(git revert*)",
  "Bash(git rm*)",
  "Bash(git stash*)",
  "Bash(git switch*)",
  "Bash(git tag*)",
  "Bash(git update-ref*)",
  "Bash(npm ci*)",
  "Bash(npm install*)",
  "Bash(npm publish*)",
  "Bash(npm run format*)",
  "Bash(npm update*)",
  "Bash(npx prettier*)",
  "Bash(pnpm add*)",
  "Bash(pnpm dlx prettier*)",
  "Bash(pnpm format*)",
  "Bash(pnpm install*)",
  "Bash(pnpm publish*)",
  "Bash(pnpm update*)",
  "Bash(pnpm up*)",
  "Bash(yarn add*)",
  "Bash(yarn install*)",
  "Bash(yarn publish*)",
  "Bash(yarn upgrade*)",
  "Bash(bun add*)",
  "Bash(bun install*)",
  "Bash(bun update*)",
  "Bash(pip install*)",
  "Bash(pip3 install*)",
  "Bash(uv add*)",
  "Bash(uv sync*)",
  "Bash(cargo add*)",
  "Bash(cargo fmt*)",
  "Bash(cargo install*)",
  "Bash(cargo publish*)",
  "Bash(cargo update*)",
  "Bash(gofmt*)",
  "Bash(rustfmt*)",
  "Bash(gh api*)",
  "Bash(gh issue comment*)",
  "Bash(gh pr comment*)",
  "Bash(gh pr review*)",
] as const

type OpenCodePermissionAction = "allow" | "deny"

type OpenCodePermissionRule =
  | OpenCodePermissionAction
  | Readonly<Record<string, OpenCodePermissionAction>>

/** Provider-native controls detected for the selected provider executable or SDK. */
export type ReviewAgentPermissionCapabilities =
  | {
      readonly provider: "opencode"
      readonly toolPermissions: boolean
    }
  | {
      readonly provider: "claude"
      readonly exactToolAllowlist: boolean
      readonly nonInteractivePermissionMode: boolean
    }
  | {
      readonly provider: "codex"
      readonly readOnlySandbox: boolean
      readonly nonInteractiveApprovalPolicy: boolean
    }

/** Provider-native OpenCode SDK configuration for a read-only thread turn. */
export interface OpenCodeReviewPermissionConfig {
  readonly provider: "opencode"
  readonly sdkConfig: {
    readonly permission: Readonly<Record<string, OpenCodePermissionRule>>
  }
}

/** Provider-native Claude CLI arguments for a read-only, noninteractive thread turn. */
export interface ClaudeReviewPermissionConfig {
  readonly provider: "claude"
  readonly cliArgs: readonly string[]
  readonly availableTools: readonly string[]
  readonly allowedTools: readonly string[]
  readonly deniedTools: readonly string[]
}

/** Provider-native Codex CLI arguments for a read-only, noninteractive thread turn. */
export interface CodexReviewPermissionConfig {
  readonly provider: "codex"
  readonly cliArgs: readonly string[]
}

/** Concrete provider configuration that enforces the provider-neutral thread policy. */
export type ReviewAgentPermissionConfig =
  | OpenCodeReviewPermissionConfig
  | ClaudeReviewPermissionConfig
  | CodexReviewPermissionConfig

/** Fail-closed result of translating the thread policy into provider-native controls. */
export type ReviewAgentPermissionCapabilityResult =
  | {
      readonly enabled: true
      readonly provider: ReviewAgentProviderId
      readonly permissions: ReviewAgentPermissions
      readonly config: ReviewAgentPermissionConfig
    }
  | {
      readonly enabled: false
      readonly provider: ReviewAgentProviderId
      readonly reason: string
    }

/** Builds provider-native controls or disables tool mode when required controls are unavailable. */
export const resolveReviewAgentPermissionConfig = (
  permissions: ReviewAgentPermissions,
  capabilities: ReviewAgentPermissionCapabilities,
): ReviewAgentPermissionCapabilityResult => {
  switch (capabilities.provider) {
    case "opencode":
      if (!capabilities.toolPermissions) {
        return disabled("opencode", "OpenCode tool permissions are unavailable")
      }
      return enabled(permissions, {
        provider: "opencode",
        sdkConfig: {
          permission: {
            "*": "deny",
            read: {
              "*": "allow",
              "*.env": "deny",
              "*.env.*": "deny",
              "*.env.example": "allow",
            },
            glob: "allow",
            grep: "allow",
            webfetch: "allow",
            websearch: "allow",
            "diffdash_*": "allow",
            edit: "deny",
            bash: "deny",
            external_directory: "deny",
          },
        },
      })
    case "claude": {
      if (!capabilities.exactToolAllowlist || !capabilities.nonInteractivePermissionMode) {
        return disabled(
          "claude",
          "Claude exact tool allowlisting and noninteractive permission controls are required",
        )
      }
      const allowedTools = [
        "Read",
        "Glob",
        "Grep",
        "WebFetch",
        "WebSearch",
        ...DIFFDASH_MCP_TOOLS.map((tool) => `mcp__diffdash__${tool}`),
      ]
      const availableTools = [...CLAUDE_BUILT_IN_TOOLS]
      const deniedTools = [...CLAUDE_DENIED_TOOLS]
      return enabled(permissions, {
        provider: "claude",
        availableTools,
        allowedTools,
        deniedTools,
        cliArgs: [
          "--setting-sources",
          "",
          "--disable-slash-commands",
          "--print",
          "--permission-mode",
          "dontAsk",
          "--strict-mcp-config",
          "--tools",
          availableTools.join(","),
          "--allowedTools",
          allowedTools.join(","),
          "--disallowedTools",
          deniedTools.join(","),
        ],
      })
    }
    case "codex":
      if (!capabilities.readOnlySandbox || !capabilities.nonInteractiveApprovalPolicy) {
        return disabled(
          "codex",
          "Codex read-only sandbox and noninteractive approval controls are required",
        )
      }
      return enabled(permissions, {
        provider: "codex",
        cliArgs: [
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
        ],
      })
  }
}

const enabled = (
  permissions: ReviewAgentPermissions,
  config: ReviewAgentPermissionConfig,
): ReviewAgentPermissionCapabilityResult => ({
  enabled: true,
  provider: config.provider,
  permissions,
  config,
})

const disabled = (
  provider: ReviewAgentProviderId,
  reason: string,
): ReviewAgentPermissionCapabilityResult => ({ enabled: false, provider, reason })
