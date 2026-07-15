import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Redacted } from "effect"

import { THREAD_MODE_REVIEW_AGENT_PERMISSIONS } from "@diffdash/domain/review-agent"
import { makeOpenCodeServerConfig, resolveOpenCodeExecutable } from "./opencode-sdk-client"
import { resolveReviewAgentPermissionConfig } from "./review-agent-permissions"

describe("OpenCode SDK client boundary", () => {
  it("FUN-73 AC: resolves OpenCode from the normalized GUI PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "diffdash-opencode-"))
    try {
      const bin = join(home, ".local", "bin")
      const executable = join(bin, "opencode")
      mkdirSync(bin, { recursive: true })
      writeFileSync(executable, "#!/bin/sh\nexit 0\n", "utf8")
      chmodSync(executable, 0o755)

      expect(resolveOpenCodeExecutable({ envPath: "", home, platform: "darwin" })).toBe(executable)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("FUN-73 AC: builds ephemeral read-only config with scoped DiffDash MCP access", () => {
    const permissions = resolveReviewAgentPermissionConfig(THREAD_MODE_REVIEW_AGENT_PERMISSIONS, {
      provider: "opencode",
      toolPermissions: true,
    })
    if (!permissions.enabled || permissions.config.provider !== "opencode") {
      throw new Error("Expected OpenCode permissions")
    }

    const config = makeOpenCodeServerConfig(permissions.config.sdkConfig, {
      url: "http://127.0.0.1:8123/mcp",
      bearerToken: Redacted.make("run-token"),
    })

    expect(config.permission).toMatchObject({
      "*": "deny",
      read: { "*": "allow", "*.env": "deny" },
      edit: "deny",
      bash: "deny",
      "diffdash_*": "allow",
    })
    expect(config.share).toBe("disabled")
    expect(config.mcp?.diffdash).toEqual({
      type: "remote",
      url: "http://127.0.0.1:8123/mcp",
      enabled: true,
      oauth: false,
      headers: { Authorization: "Bearer run-token" },
    })
  })
})
