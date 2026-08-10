import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import { decodeReviewThreadRow, ReviewAnchorRowDecodeError } from "./review-thread-row"

const anchor = {
  _tag: "line",
  fileId: "file-1",
  filePath: "src/app.ts",
  oldPath: null,
  hunkId: "hunk-1",
  hunkFingerprint: "fingerprint-1",
  hunkHeader: "@@ -1 +1 @@",
  side: "new",
  lineNumber: 1,
  lineContent: "new",
} as const

const row = {
  id: "thread-1",
  repo_id: "github:fungsi/diffdash",
  review_key: "github:1",
  pr_number: 1,
  base_sha: "base",
  head_sha: "head",
  current_base_sha: "base",
  current_head_sha: "head",
  original_anchor_json: JSON.stringify(anchor),
  current_anchor_json: JSON.stringify(anchor),
  anchor_status: "active",
  status: "open",
  closed_at: null,
  created_at: "2026-08-10T00:00:00.000Z",
  updated_at: "2026-08-10T00:00:00.000Z",
} as const

describe("review thread row compatibility", () => {
  it.effect("maps a valid legacy carried_forward row to the canonical active state", () =>
    Effect.gen(function* () {
      const thread = yield* decodeReviewThreadRow({ ...row, anchor_status: "carried_forward" })

      expect(thread.currentAnchor).toMatchObject({ _tag: "Active", anchor })
    }),
  )

  it.effect("rejects active statuses without a current anchor", () =>
    Effect.gen(function* () {
      for (const anchorStatus of ["active", "carried_forward"] as const) {
        const result = yield* Effect.result(
          decodeReviewThreadRow({
            ...row,
            anchor_status: anchorStatus,
            current_anchor_json: null,
          }),
        )

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(ReviewAnchorRowDecodeError)
          expect(result.failure).toMatchObject({
            anchorStatus,
            hasCurrentAnchor: false,
          })
        }
      }
    }),
  )

  it.effect("rejects inactive statuses retaining a current anchor", () =>
    Effect.gen(function* () {
      for (const anchorStatus of ["outdated", "unresolved_anchor"] as const) {
        const result = yield* Effect.result(
          decodeReviewThreadRow({ ...row, anchor_status: anchorStatus }),
        )

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(ReviewAnchorRowDecodeError)
          expect(result.failure).toMatchObject({
            anchorStatus,
            hasCurrentAnchor: true,
          })
        }
      }
    }),
  )
})
