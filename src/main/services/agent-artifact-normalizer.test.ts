import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Buffer } from "node:buffer"

import { AgentArtifactNormalizer } from "./agent-artifact-normalizer"

describe("AgentArtifactNormalizer", () => {
  it.effect("FUN-77 AC: normalizes Claude Read, Codex command, and MCP result fixtures", () =>
    Effect.gen(function* () {
      const normalizer = yield* AgentArtifactNormalizer
      const claudeRead = yield* normalizer.normalize({
        type: "file_read",
        provider: "claude",
        title: "Read src/app.ts",
        content: "export const app = true",
        metadata: { toolName: "Read", path: "src/app.ts" },
      })
      const codexCommand = yield* normalizer.normalize({
        type: "shell_output",
        provider: "codex",
        title: "git status --short",
        content: " M src/app.ts",
        metadata: { toolName: "command_execution", command: "git status --short", exitCode: 0 },
      })
      const mcpResult = yield* normalizer.normalize({
        type: "mcp_tool_result",
        provider: "opencode",
        title: "getDiffHunk",
        content: "@@ -1 +1 @@",
        metadata: { toolName: "getDiffHunk", hunkId: "hunk-42" },
      })

      expect(claudeRead).toMatchObject({
        type: "file_read",
        provider: "claude",
        metadata: expect.objectContaining({
          sourceProvider: "claude",
          toolName: "Read",
          path: "src/app.ts",
        }),
      })
      expect(codexCommand.metadata).toEqual(
        expect.objectContaining({ command: "git status --short", sourceProvider: "codex" }),
      )
      expect(mcpResult.metadata).toEqual(
        expect.objectContaining({ hunkId: "hunk-42", sourceProvider: "opencode" }),
      )
    }).pipe(Effect.provide(AgentArtifactNormalizer.layer)),
  )

  it.effect(
    "FUN-77 AC: falls back to a normalized unknown artifact without raw event storage",
    () =>
      Effect.gen(function* () {
        const normalizer = yield* AgentArtifactNormalizer
        const artifact = yield* normalizer.normalize({
          type: "unknown",
          provider: "claude",
          title: "Unknown Claude event",
          content: "Provider emitted an unsupported event",
          metadata: { eventType: "future_event" },
        })

        expect(artifact).toMatchObject({
          type: "unknown",
          content: "Provider emitted an unsupported event",
          metadata: expect.objectContaining({
            eventType: "future_event",
            sourceProvider: "claude",
          }),
        })
        expect(artifact.metadata).not.toHaveProperty("rawEvent")
      }).pipe(Effect.provide(AgentArtifactNormalizer.layer)),
  )

  it.effect("FUN-77 AC: computes a stable digest from full content and canonical metadata", () =>
    Effect.gen(function* () {
      const normalizer = yield* AgentArtifactNormalizer
      const content = "0123456789".repeat(20)
      const first = yield* normalizer.normalize({
        type: "web_result",
        provider: "claude",
        title: "Result",
        content,
        metadata: { url: "https://example.com", nested: { z: 2, a: 1 } },
        maxContentBytes: 64,
      })
      const reordered = yield* normalizer.normalize({
        type: "web_result",
        provider: "claude",
        title: "Different display title",
        content,
        metadata: { nested: { a: 1, z: 2 }, url: "https://example.com" },
        maxContentBytes: 120,
      })
      const changedMetadata = yield* normalizer.normalize({
        type: "web_result",
        provider: "claude",
        title: "Result",
        content,
        metadata: { nested: { a: 1, z: 3 }, url: "https://example.com" },
        maxContentBytes: 64,
      })

      expect(first.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(reordered.contentDigest).toBe(first.contentDigest)
      expect(changedMetadata.contentDigest).not.toBe(first.contentDigest)
      expect(first.content).not.toBe(reordered.content)
    }).pipe(Effect.provide(AgentArtifactNormalizer.layer)),
  )

  it.effect("FUN-77 AC: bounds UTF-8 content and records explicit truncation metadata", () =>
    Effect.gen(function* () {
      const normalizer = yield* AgentArtifactNormalizer
      const content = "source line\n".repeat(20) + "four-byte: \u{1F680}"
      const artifact = yield* normalizer.normalize({
        type: "search_result",
        provider: "codex",
        title: "Large search",
        content,
        metadata: { toolName: "search", path: "src" },
        maxContentBytes: 80,
      })

      expect(Buffer.byteLength(artifact.content, "utf8")).toBeLessThanOrEqual(80)
      expect(artifact.truncated).toBe(true)
      expect(artifact.originalSize).toBe(Buffer.byteLength(content, "utf8"))
      expect(artifact.metadata).toEqual(
        expect.objectContaining({
          truncation: {
            truncated: true,
            originalSizeBytes: Buffer.byteLength(content, "utf8"),
            retainedSizeBytes: Buffer.byteLength(artifact.content, "utf8"),
            limitBytes: 80,
          },
        }),
      )
    }).pipe(Effect.provide(AgentArtifactNormalizer.layer)),
  )
})
