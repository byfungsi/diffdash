import { Effect, Schema } from "effect"

import { getHiddenDiffFileReason } from "./diff-file-filters"
import { ParsedDiffFile } from "./domain"

/** Prompt/cache version for the bounded hunk-backed walkthrough contract. */
export const WALKTHROUGH_PROMPT_VERSION = "walkthrough-v3"

/** Default safety budget for AI walkthrough prompt preparation. */
export const DEFAULT_WALKTHROUGH_PROMPT_BUDGET = {
  maxDiffChars: 120_000,
  maxFiles: 80,
  maxHunks: 160,
  maxLinesPerHunk: 80,
} as const

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

/** Prompt input prepared from a parsed diff after filtering and size bounding. */
export interface WalkthroughPromptInput {
  readonly diff: string
  readonly hunkDigest: readonly WalkthroughHunkDigest[]
  readonly stats: WalkthroughPromptStats
}

/** Safety budget for preparing walkthrough prompt input. */
export interface WalkthroughPromptBudget {
  readonly maxDiffChars: number
  readonly maxFiles: number
  readonly maxHunks: number
  readonly maxLinesPerHunk: number
}

/** Summary of prompt filtering and truncation applied before generation. */
export interface WalkthroughPromptStats {
  readonly totalFiles: number
  readonly selectedFiles: number
  readonly hiddenFiles: number
  readonly omittedFiles: number
  readonly totalHunks: number
  readonly selectedHunks: number
  readonly omittedHunks: number
  readonly truncatedHunks: number
  readonly truncatedByCharBudget: boolean
  readonly usedHiddenFallback: boolean
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

/** Recoverable failure when a diff cannot produce a useful walkthrough prompt. */
export class WalkthroughPromptPreparationError extends Schema.TaggedError<WalkthroughPromptPreparationError>()(
  "WalkthroughPromptPreparationError",
  {
    message: Schema.String,
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

/** Builds bounded, noise-filtered prompt input for walkthrough generation. */
export const prepareWalkthroughPromptInput = (
  files: readonly ParsedDiffFile[],
  scope: string,
  budget: WalkthroughPromptBudget = DEFAULT_WALKTHROUGH_PROMPT_BUDGET,
): Effect.Effect<WalkthroughPromptInput, WalkthroughPromptPreparationError> => {
  const validBudget = normalizePromptBudget(budget)
  const hiddenFiles = files.filter((file) => getHiddenDiffFileReason(file) !== null)
  const visibleFiles = files.filter((file) => getHiddenDiffFileReason(file) === null)
  const usedHiddenFallback = visibleFiles.length === 0 && files.length > 0
  const candidateFiles = usedHiddenFallback ? files : visibleFiles
  const totalHunks = files.reduce((total, file) => total + fileReviewUnitCount(file), 0)
  const chunks: string[] = []
  const hunkDigest: WalkthroughHunkDigest[] = []
  const selectedFilePaths = new Set<string>()
  let selectedHunks = 0
  let truncatedHunks = 0
  let truncatedByCharBudget = false

  for (const file of candidateFiles) {
    if (selectedFilePaths.size >= validBudget.maxFiles) break
    const entries = filePromptEntries(file, scope)
    let selectedFile = false

    for (const entry of entries) {
      if (selectedHunks >= validBudget.maxHunks) break

      const alias = hunkAlias(hunkDigest.length)
      const excerpt = promptExcerptForEntry(file, entry, alias, validBudget.maxLinesPerHunk)
      const nextDiff = appendPromptChunk(chunks, excerpt)
      if (nextDiff.length > validBudget.maxDiffChars) {
        truncatedByCharBudget = true
        if (hunkDigest.length === 0) {
          const truncatedExcerpt = truncateText(excerpt, validBudget.maxDiffChars)
          chunks.push(truncatedExcerpt.text)
          truncatedHunks += truncatedExcerpt.truncated ? 1 : 0
          hunkDigest.push(entry.digest)
          selectedHunks += 1
          selectedFile = true
        }
        break
      }

      chunks.push(excerpt.text)
      hunkDigest.push(entry.digest)
      selectedHunks += 1
      selectedFile = true
      if (excerpt.truncated) truncatedHunks += 1
    }

    if (selectedFile) selectedFilePaths.add(file.path)
    if (selectedHunks >= validBudget.maxHunks || truncatedByCharBudget) break
  }

  if (hunkDigest.length === 0) {
    return WalkthroughPromptPreparationError.make({
      message: "Cannot generate a walkthrough because the diff has no reviewable changes.",
      details: [
        `Parsed ${files.length} changed file${files.length === 1 ? "" : "s"}.`,
        `Parsed ${totalHunks} review unit${totalHunks === 1 ? "" : "s"}.`,
      ],
    })
  }

  return Effect.succeed({
    diff: chunks.join("\n\n"),
    hunkDigest,
    stats: {
      hiddenFiles: hiddenFiles.length,
      omittedFiles: Math.max(0, files.length - selectedFilePaths.size),
      omittedHunks: Math.max(0, totalHunks - selectedHunks),
      selectedFiles: selectedFilePaths.size,
      selectedHunks,
      totalFiles: files.length,
      totalHunks,
      truncatedByCharBudget,
      truncatedHunks,
      usedHiddenFallback,
    },
  })
}

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

interface WalkthroughPromptEntry {
  readonly digest: WalkthroughHunkDigest
  readonly lines: readonly string[]
}

const normalizePromptBudget = (budget: WalkthroughPromptBudget): WalkthroughPromptBudget => ({
  maxDiffChars: positiveIntegerOrDefault(
    budget.maxDiffChars,
    DEFAULT_WALKTHROUGH_PROMPT_BUDGET.maxDiffChars,
  ),
  maxFiles: positiveIntegerOrDefault(budget.maxFiles, DEFAULT_WALKTHROUGH_PROMPT_BUDGET.maxFiles),
  maxHunks: positiveIntegerOrDefault(budget.maxHunks, DEFAULT_WALKTHROUGH_PROMPT_BUDGET.maxHunks),
  maxLinesPerHunk: positiveIntegerOrDefault(
    budget.maxLinesPerHunk,
    DEFAULT_WALKTHROUGH_PROMPT_BUDGET.maxLinesPerHunk,
  ),
})

const positiveIntegerOrDefault = (value: number, fallback: number) =>
  Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback

const fileReviewUnitCount = (file: ParsedDiffFile) => Math.max(1, file.hunks.length)

const filePromptEntries = (
  file: ParsedDiffFile,
  scope: string,
): readonly WalkthroughPromptEntry[] => {
  if (file.hunks.length === 0) {
    return [
      {
        digest: {
          id: walkthroughHunkId(file.path, scope, 1),
          path: file.path,
          header: "Synthetic review unit",
          additions: file.additions,
          deletions: file.deletions,
          synthetic: true,
        },
        lines: file.patch.split("\n"),
      },
    ]
  }

  return file.hunks.map((hunk, index) => {
    const { additions, deletions } = countHunkLines(hunk.lines)
    return {
      digest: {
        id: walkthroughHunkId(file.path, scope, index + 1),
        path: file.path,
        header: hunk.header,
        additions,
        deletions,
        synthetic: false,
      },
      lines: hunk.lines,
    }
  })
}

const promptExcerptForEntry = (
  file: ParsedDiffFile,
  entry: WalkthroughPromptEntry,
  alias: string,
  maxLinesPerHunk: number,
) => {
  const clipped = truncateLines(entry.lines, maxLinesPerHunk)
  const header = [
    `### ${alias} ${entry.digest.path}`,
    `status=${file.status} additions=${entry.digest.additions} deletions=${entry.digest.deletions} synthetic=${entry.digest.synthetic ? 1 : 0}`,
  ]
  const lines = entry.digest.synthetic
    ? [...header, ...clipped.lines]
    : [...header, ...fileHeader(file), entry.digest.header, ...clipped.lines]

  return {
    text: lines.join("\n"),
    truncated: clipped.truncated,
  }
}

const truncateLines = (lines: readonly string[], maxLines: number) => {
  if (lines.length <= maxLines) return { lines: [...lines], truncated: false }
  return {
    lines: [...lines.slice(0, maxLines), `[... ${lines.length - maxLines} lines omitted ...]`],
    truncated: true,
  }
}

const appendPromptChunk = (chunks: readonly string[], chunk: { readonly text: string }) =>
  chunks.length === 0 ? chunk.text : `${chunks.join("\n\n")}\n\n${chunk.text}`

const truncateText = (chunk: { readonly text: string }, maxChars: number) => {
  if (chunk.text.length <= maxChars) return { text: chunk.text, truncated: false }

  const marker = "\n[... prompt excerpt truncated to fit budget ...]"
  if (maxChars <= marker.length) return { text: chunk.text.slice(0, maxChars), truncated: true }

  return {
    text: `${chunk.text.slice(0, maxChars - marker.length)}${marker}`,
    truncated: true,
  }
}

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

const hunkAlias = (index: number) => `h${index + 1}`

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
