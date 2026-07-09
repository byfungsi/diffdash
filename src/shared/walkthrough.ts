import { Effect, Schema } from "effect"

import { ParsedDiffFile } from "./domain"

/** Prompt/cache version for the Codiff-style hunk-backed walkthrough contract. */
export const WALKTHROUGH_PROMPT_VERSION = "walkthrough-v2"

/** Risk level assigned to a walkthrough stop. */
export const WalkthroughRisk = Schema.Literal("critical", "review", "support")

/** Risk level assigned to a walkthrough stop. */
export type WalkthroughRisk = typeof WalkthroughRisk.Type

/** One ordered narrative review stop backed by deterministic hunk IDs. */
export class WalkthroughStop extends Schema.Class<WalkthroughStop>("WalkthroughStop")({
  id: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  risk: WalkthroughRisk,
  hunkIds: Schema.Array(Schema.String),
}) {}

/** A conceptual group of walkthrough stops in reviewer-oriented order. */
export class WalkthroughChapter extends Schema.Class<WalkthroughChapter>("WalkthroughChapter")({
  id: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  stops: Schema.Array(WalkthroughStop),
}) {}

/** Lower-priority hunks that stay outside the main review path. */
export class WalkthroughSupportItem extends Schema.Class<WalkthroughSupportItem>(
  "WalkthroughSupportItem",
)({
  id: Schema.String,
  title: Schema.String,
  reason: Schema.String,
  hunkIds: Schema.Array(Schema.String),
}) {}

/** AI-generated hunk-backed review path for a PR or local diff. */
export class Walkthrough extends Schema.Class<Walkthrough>("Walkthrough")({
  title: Schema.String,
  summary: Schema.String,
  chapters: Schema.Array(WalkthroughChapter),
  support: Schema.Array(WalkthroughSupportItem),
}) {}

/** Cached walkthrough artifact keyed by a concrete review target and prompt version. */
export class StoredWalkthrough extends Schema.Class<StoredWalkthrough>("StoredWalkthrough")({
  repoId: Schema.String,
  prNumber: Schema.NullOr(Schema.Number),
  reviewKey: Schema.String,
  baseSha: Schema.String,
  headSha: Schema.String,
  promptVersion: Schema.String,
  walkthrough: Walkthrough,
  createdAt: Schema.String,
}) {}

/** Lookup key for cached walkthrough artifacts. */
export interface WalkthroughCacheKey {
  readonly repoId: string
  readonly reviewKey: string
  readonly baseSha: string
  readonly headSha: string
  readonly promptVersion: string
}

/** Input for creating or overwriting a cached walkthrough artifact. */
export interface SaveWalkthroughInput extends WalkthroughCacheKey {
  readonly prNumber: number | null
  readonly walkthrough: Walkthrough
}

/** Deterministic hunk metadata exposed to the walkthrough generator and renderer. */
export interface WalkthroughHunkDigest {
  readonly id: string
  readonly path: string
  readonly header: string
  readonly additions: number
  readonly deletions: number
  readonly synthetic: boolean
}

/** Review scope segment used in deterministic hunk IDs for GitHub pull requests. */
export const walkthroughPullRequestScope = (number: number) => `pull-request:${number}`

/** Review scope segment used in deterministic hunk IDs for local working tree changes. */
export const walkthroughLocalDiffScope = (headSha: string) => `local-diff:${headSha}`

/** Recoverable validation failure for generated walkthrough output. */
export class WalkthroughValidationError extends Schema.TaggedError<WalkthroughValidationError>()(
  "WalkthroughValidationError",
  {
    reason: Schema.String,
    details: Schema.Array(Schema.String),
  },
) {}

/**
 * Builds deterministic hunk IDs for a parsed diff using a stable review scope.
 */
export const buildWalkthroughHunkDigest = (
  files: readonly ParsedDiffFile[],
  scope: string,
): readonly WalkthroughHunkDigest[] =>
  files.flatMap((file): WalkthroughHunkDigest[] => {
    if (file.hunks.length === 0) {
      return [
        {
          id: walkthroughHunkId(file.path, scope, 1),
          path: file.path,
          header: "Synthetic review unit",
          additions: file.additions,
          deletions: file.deletions,
          synthetic: true,
        },
      ]
    }

    return file.hunks.map((hunk, index) => {
      const { additions, deletions } = countHunkLines(hunk.lines)
      return {
        id: walkthroughHunkId(file.path, scope, index + 1),
        path: file.path,
        header: hunk.header,
        additions,
        deletions,
        synthetic: false,
      }
    })
  })

/**
 * Decodes generated walkthrough output, validates hunk references, and adds omitted hunks to Support.
 */
export const validateWalkthrough = (
  input: unknown,
  hunkDigest: readonly WalkthroughHunkDigest[],
): Effect.Effect<Walkthrough, WalkthroughValidationError> =>
  Schema.decodeUnknown(Walkthrough)(normalizeWalkthroughInput(input)).pipe(
    Effect.mapError(() =>
      WalkthroughValidationError.make({
        reason: "invalid_shape",
        details: ["Walkthrough output does not match the required JSON contract."],
      }),
    ),
    Effect.flatMap((walkthrough) => validateWalkthroughHunkCoverage(walkthrough, hunkDigest)),
  )

/** Creates focused file patches for the selected hunk IDs. */
export const focusFilesForWalkthroughHunks = (
  files: readonly ParsedDiffFile[],
  hunkIds: readonly string[],
  scope: string,
): readonly ParsedDiffFile[] => {
  const selectedIds = new Set(hunkIds)
  return files.flatMap((file) => {
    const hunkEntries = file.hunks.map((hunk, index) => ({
      hunk,
      id: walkthroughHunkId(file.path, scope, index + 1),
    }))

    if (hunkEntries.length === 0) {
      return selectedIds.has(walkthroughHunkId(file.path, scope, 1)) ? [file] : []
    }

    const selectedHunks = hunkEntries.filter((entry) => selectedIds.has(entry.id))
    if (selectedHunks.length === 0) return []

    const headerLines = fileHeader(file)
    const hunkLines = selectedHunks.flatMap((entry) => [entry.hunk.header, ...entry.hunk.lines])
    const patch = [...headerLines, ...hunkLines].join("\n")
    const { additions, deletions } = countHunkLines(hunkLines)

    return [
      ParsedDiffFile.make({
        ...file,
        reviewKey: `${file.reviewKey}:${selectedHunks.map((entry) => entry.id).join(",")}`,
        additions,
        deletions,
        hunks: selectedHunks.map((entry) => entry.hunk),
        patch,
      }),
    ]
  })
}

/** Summarizes selected hunk IDs into path-level line totals for sidebar rows. */
export const summarizeWalkthroughHunksByPath = (
  hunkDigest: readonly WalkthroughHunkDigest[],
  hunkIds: readonly string[],
) => {
  const selectedIds = new Set(hunkIds)
  const order: string[] = []
  const totalsByPath = new Map<string, { additions: number; deletions: number; path: string }>()

  for (const hunk of hunkDigest) {
    if (!selectedIds.has(hunk.id)) continue
    const current = totalsByPath.get(hunk.path)
    if (current === undefined) {
      order.push(hunk.path)
      totalsByPath.set(hunk.path, {
        path: hunk.path,
        additions: hunk.additions,
        deletions: hunk.deletions,
      })
    } else {
      totalsByPath.set(hunk.path, {
        path: hunk.path,
        additions: current.additions + hunk.additions,
        deletions: current.deletions + hunk.deletions,
      })
    }
  }

  return order.map((path) => totalsByPath.get(path)).filter(isDefined)
}

/** Flattens walkthrough chapters into globally ordered stops. */
export const flattenWalkthroughStops = (walkthrough: Walkthrough) =>
  walkthrough.chapters.flatMap((chapter) =>
    chapter.stops.map((stop) => ({
      chapter,
      stop,
    })),
  )

const validateWalkthroughHunkCoverage = (
  walkthrough: Walkthrough,
  hunkDigest: readonly WalkthroughHunkDigest[],
): Effect.Effect<Walkthrough, WalkthroughValidationError> => {
  const expectedIds = new Set(hunkDigest.map((hunk) => hunk.id))
  const omittedIds = new Set(expectedIds)
  const seenIds = new Set<string>()
  const details: string[] = []

  if (walkthrough.chapters.length === 0) {
    details.push("Walkthrough must contain at least one chapter.")
  }

  walkthrough.chapters.forEach((chapter, chapterIndex) => {
    if (chapter.stops.length === 0) {
      details.push(`Chapter ${chapterIndex + 1} (${chapter.title}) does not contain any stops.`)
    }
    chapter.stops.forEach((stop, stopIndex) => {
      validateHunkIdList(
        stop.hunkIds,
        `Chapter ${chapterIndex + 1}, stop ${stopIndex + 1} (${stop.title})`,
        expectedIds,
        omittedIds,
        seenIds,
        details,
      )
    })
  })

  walkthrough.support.forEach((item, itemIndex) => {
    validateHunkIdList(
      item.hunkIds,
      `Support item ${itemIndex + 1} (${item.title})`,
      expectedIds,
      omittedIds,
      seenIds,
      details,
    )
  })

  if (details.length > 0) {
    return WalkthroughValidationError.make({
      reason: "invalid_hunk_coverage",
      details,
    })
  }

  if (omittedIds.size === 0) return Effect.succeed(walkthrough)

  return Effect.succeed(
    Walkthrough.make({
      ...walkthrough,
      support: [
        ...walkthrough.support,
        WalkthroughSupportItem.make({
          id: "support-omitted-hunks",
          title: "Other changes",
          reason: "Not included in the generated walkthrough.",
          hunkIds: [...omittedIds],
        }),
      ],
    }),
  )
}

const normalizeWalkthroughInput = (input: unknown): unknown => {
  if (!isRecord(input)) return input
  if ("support" in input && input.support !== undefined) return input
  return { ...input, support: [] }
}

const validateHunkIdList = (
  hunkIds: readonly string[],
  label: string,
  expectedIds: ReadonlySet<string>,
  omittedIds: Set<string>,
  seenIds: Set<string>,
  details: string[],
) => {
  if (hunkIds.length === 0) {
    details.push(`${label} does not contain any hunk IDs.`)
  }

  hunkIds.forEach((hunkId) => {
    if (!expectedIds.has(hunkId)) {
      details.push(`${label} references an unknown hunk ID: ${hunkId}`)
      return
    }

    if (seenIds.has(hunkId)) {
      details.push(`${label} duplicates hunk ID: ${hunkId}`)
      return
    }

    seenIds.add(hunkId)
    omittedIds.delete(hunkId)
  })
}

const walkthroughHunkId = (path: string, scope: string, ordinal: number) =>
  `${path}:${scope}:h${ordinal}`

const countHunkLines = (lines: readonly string[]) =>
  lines.reduce(
    (total, line) => ({
      additions: total.additions + (line.startsWith("+") && !line.startsWith("+++") ? 1 : 0),
      deletions: total.deletions + (line.startsWith("-") && !line.startsWith("---") ? 1 : 0),
    }),
    { additions: 0, deletions: 0 },
  )

const fileHeader = (file: ParsedDiffFile) => {
  const lines = file.patch.split("\n")
  const firstHunkIndex = lines.findIndex((line) => line.startsWith("@@ "))
  return firstHunkIndex >= 0 ? lines.slice(0, firstHunkIndex) : lines
}

const isDefined = <A>(value: A | undefined): value is A => value !== undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
