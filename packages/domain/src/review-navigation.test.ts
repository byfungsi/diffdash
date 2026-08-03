import { describe, expect, it } from "@effect/vitest"
import { Either, Schema } from "effect"

import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewProjectId,
  ReviewSnapshotId,
} from "./review-identity"
import {
  ExtensionReviewNavigationTarget,
  FileReviewNavigationTarget,
  HunkReviewNavigationTarget,
  LineReviewNavigationTarget,
  RangeReviewNavigationTarget,
  REVIEW_EXTENSION_TARGET_MAX_BYTES,
  ReviewLinePoint,
  ReviewLocationV1,
  ReviewNavigationExtensionId,
  ReviewNavigationTarget,
  ReviewSnapshotAddress,
  ThreadReviewNavigationTarget,
} from "./review-navigation"
import { ReviewThreadId } from "./review-thread"

const fileId = ReviewFileId.make("file:src/app.ts")
const hunkId = ReviewHunkId.make("hunk:src/app.ts:1")
const hunkFingerprint = ReviewHunkFingerprint.make("hunk-content:app")
const snapshot = ReviewSnapshotAddress.make({
  projectId: ReviewProjectId.make("github:fungsi/diffdash"),
  snapshotId: ReviewSnapshotId.make("snapshot:v1:1234567890abcdef1234567890abcdef"),
})
const point = ReviewLinePoint.make({
  hunkId,
  hunkFingerprint,
  side: "new",
  lineNumber: 12,
  column: 3,
})

describe("review navigation schema", () => {
  it("FUN-212 AC: round-trips every version 1 semantic target", () => {
    const targets = [
      FileReviewNavigationTarget.make({ fileId }),
      HunkReviewNavigationTarget.make({ fileId, hunkId, hunkFingerprint }),
      LineReviewNavigationTarget.make({ fileId, point }),
      Schema.decodeUnknownSync(RangeReviewNavigationTarget)({
        _tag: "range",
        fileId,
        start: point,
        end: { ...point, column: 7 },
      }),
      ThreadReviewNavigationTarget.make({ threadId: ReviewThreadId.make("thread-1") }),
      Schema.decodeUnknownSync(ExtensionReviewNavigationTarget)({
        _tag: "extension",
        extensionId: ReviewNavigationExtensionId.make("com.fungsi.example"),
        targetType: "annotation",
        targetId: "finding-1",
        payloadVersion: 1,
        payload: { severity: "warning", lines: [12, 13] },
      }),
    ]

    for (const target of targets) {
      const location = ReviewLocationV1.make({ version: 1, snapshot, target })
      const encoded = Schema.encodeSync(ReviewLocationV1)(location)
      expect(Schema.decodeUnknownSync(ReviewLocationV1)(encoded)).toEqual(location)
    }
  })

  it("rejects unknown location versions", () => {
    const result = Schema.decodeUnknownEither(ReviewLocationV1)({
      version: 2,
      snapshot,
      target: FileReviewNavigationTarget.make({ fileId }),
    })

    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects invalid coordinates and reversed same-hunk ranges", () => {
    const invalidPoint = Schema.decodeUnknownEither(ReviewLinePoint)({
      hunkId,
      hunkFingerprint,
      side: "new",
      lineNumber: -1,
    })
    const reversedRange = Schema.decodeUnknownEither(RangeReviewNavigationTarget)({
      _tag: "range",
      fileId,
      start: { ...point, lineNumber: 20 },
      end: { ...point, lineNumber: 10 },
    })

    expect(Either.isLeft(invalidPoint)).toBe(true)
    expect(Either.isLeft(reversedRange)).toBe(true)
  })

  it("rejects non-JSON and oversized extension payloads", () => {
    const base = {
      _tag: "extension",
      extensionId: ReviewNavigationExtensionId.make("com.fungsi.example"),
      targetType: "annotation",
      targetId: "finding-1",
      payloadVersion: 1,
    } as const
    const malformed = Schema.decodeUnknownEither(ExtensionReviewNavigationTarget)({
      ...base,
      payload: { callback: () => undefined },
    })
    const oversized = Schema.decodeUnknownEither(ReviewNavigationTarget)({
      ...base,
      payload: "x".repeat(REVIEW_EXTENSION_TARGET_MAX_BYTES + 1),
    })

    expect(Either.isLeft(malformed)).toBe(true)
    expect(Either.isLeft(oversized)).toBe(true)
  })
})
