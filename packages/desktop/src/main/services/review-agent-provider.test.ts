import { describe, expect, it } from "@effect/vitest"

import { CliStreamError } from "./cli-stream"
import {
  ReviewAgentExecutionError,
  executionFailureReason,
  mapReviewAgentExecutionError,
} from "./review-agent-provider"

describe("ReviewAgentProvider errors", () => {
  it("FUN-70 AC: maps provider failures to a provider-neutral typed error", () => {
    const error = mapReviewAgentExecutionError("opencode", new Error("server exited"))

    expect(error).toBeInstanceOf(ReviewAgentExecutionError)
    expect(error.provider).toBe("opencode")
    expect(error.reason).toBe("server exited")
  })

  it("redacts bounded subprocess diagnostics", () => {
    const reason = executionFailureReason(
      CliStreamError.make({
        command: "codex",
        args: [],
        cwd: null,
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr:
          "MCP handshake failed with Bearer secret-value DIFFDASH_MCP_BEARER_TOKEN=secret-value",
        stdoutTruncated: false,
        stderrTruncated: false,
        outputTruncated: false,
        reason: "exit",
        message: "Command exited with code 1",
        cause: null,
      }),
    )

    expect(reason).toContain("MCP handshake failed")
    expect(reason).not.toContain("secret-value")
  })
})
