import { Effect, Predicate, Schema } from "effect"
import { DiffFileVisibility, ParsedDiffFile } from "./diff"
import { type HostedReviewLocator, makeHostedReviewKey } from "./git-provider"
import { changedLineCount, isVeryLargeDiff } from "./large-diff-policy"
import {
  makeReviewFilePatchHash,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
  type ReviewKey as ReviewKeyType,
  type ReviewProjectId as ReviewProjectIdType,
  type ReviewRevision as ReviewRevisionType,
} from "./review-identity"
import { reviewPathDirectory } from "./review-path"
import { RepositoryRelativePath } from "./repository-path"
import { WalkthroughOperationPromptVersion } from "./walkthrough-operation"

/** Prompt/cache version for the bounded hunk-backed walkthrough contract. */
export const WALKTHROUGH_PROMPT_VERSION = WalkthroughOperationPromptVersion.make("walkthrough-v4")

/** Default safety budget for AI walkthrough prompt preparation. */
export const DEFAULT_WALKTHROUGH_PROMPT_BUDGET = {
  maxDiffChars: 120_000,
  maxFiles: 80,
  maxHunks: 160,
  maxLinesPerHunk: 80,
} as const

const MAX_SAMPLED_FILE_TREE_CHARS = 60_000

/** Risk level assigned to a walkthrough stop. */
export const WalkthroughRisk = Schema.Literals(["critical", "review", "support"])

/** Risk level assigned to a walkthrough stop. */
export type WalkthroughRisk = typeof WalkthroughRisk.Type

/** Stable identity for one conceptual chapter within a walkthrough artifact. */
export const WalkthroughChapterId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("WalkthroughChapterId"),
)

/** Stable identity for one conceptual chapter within a walkthrough artifact. */
export type WalkthroughChapterId = typeof WalkthroughChapterId.Type

/** Stable identity for one ordered review stop within a walkthrough artifact. */
export const WalkthroughStopId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("WalkthroughStopId"),
)

/** Stable identity for one ordered review stop within a walkthrough artifact. */
export type WalkthroughStopId = typeof WalkthroughStopId.Type

/** Stable identity for one lower-priority support item within a walkthrough artifact. */
export const WalkthroughSupportItemId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("WalkthroughSupportItemId"),
)

/** Stable identity for one lower-priority support item within a walkthrough artifact. */
export type WalkthroughSupportItemId = typeof WalkthroughSupportItemId.Type

/** Stable identity for one deterministic review hunk within a walkthrough scope. */
export const WalkthroughHunkId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("WalkthroughHunkId"),
)

/** Stable identity for one deterministic review hunk within a walkthrough scope. */
export type WalkthroughHunkId = typeof WalkthroughHunkId.Type

/** One ordered narrative review stop backed by deterministic hunk IDs. */
export class WalkthroughStop extends Schema.Class<WalkthroughStop>("WalkthroughStop")({
  id: WalkthroughStopId,
  title: Schema.String,
  summary: Schema.String,
  risk: WalkthroughRisk,
  hunkIds: Schema.Array(WalkthroughHunkId),
}) {}

/** A conceptual group of walkthrough stops in reviewer-oriented order. */
export class WalkthroughChapter extends Schema.Class<WalkthroughChapter>("WalkthroughChapter")({
  id: WalkthroughChapterId,
  title: Schema.String,
  summary: Schema.String,
  stops: Schema.Array(WalkthroughStop),
}) {}

/** Lower-priority hunks that stay outside the main review path. */
export class WalkthroughSupportItem extends Schema.Class<WalkthroughSupportItem>(
  "WalkthroughSupportItem",
)({
  id: WalkthroughSupportItemId,
  title: Schema.String,
  reason: Schema.String,
  hunkIds: Schema.Array(WalkthroughHunkId),
}) {}

/** Strategy used to prepare source material for walkthrough generation. */
export const WalkthroughGenerationMode = Schema.Literals(["standard", "sampled-tree"])

/** Strategy used to prepare source material for walkthrough generation. */
export type WalkthroughGenerationMode = typeof WalkthroughGenerationMode.Type

/** Coverage metadata explaining how much of a review informed a walkthrough. */
export class WalkthroughGenerationDetails extends Schema.Class<WalkthroughGenerationDetails>(
  "WalkthroughGenerationDetails",
)({
  mode: WalkthroughGenerationMode,
  totalFiles: Schema.Number,
  analyzedFiles: Schema.Number,
  totalFolders: Schema.Number,
  analyzedFolders: Schema.Number,
}) {}

/** AI-generated hunk-backed review path for a PR or local diff. */
export class Walkthrough extends Schema.Class<Walkthrough>("Walkthrough")({
  title: Schema.String,
  summary: Schema.String,
  chapters: Schema.Array(WalkthroughChapter),
  support: Schema.Array(WalkthroughSupportItem),
  generation: Schema.optional(WalkthroughGenerationDetails),
}) {}

/** Cached walkthrough artifact keyed by a concrete review target and prompt version. */
export class StoredWalkthrough extends Schema.Class<StoredWalkthrough>("StoredWalkthrough")({
  repoId: ReviewProjectId,
  prNumber: Schema.NullOr(Schema.Number),
  reviewKey: ReviewKey,
  baseSha: ReviewRevision,
  headSha: ReviewRevision,
  promptVersion: WalkthroughOperationPromptVersion,
  walkthrough: Walkthrough,
  createdAt: Schema.String,
}) {}

/** Lookup key for cached walkthrough artifacts. */
export interface WalkthroughCacheKey {
  readonly repoId: ReviewProjectIdType
  readonly reviewKey: ReviewKeyType
  readonly baseSha: ReviewRevisionType
  readonly headSha: ReviewRevisionType
  readonly promptVersion: WalkthroughOperationPromptVersion
}

/** Input for creating or overwriting a cached walkthrough artifact. */
export interface SaveWalkthroughInput extends WalkthroughCacheKey {
  readonly prNumber: number | null
  readonly walkthrough: Walkthrough
}

/** Deterministic hunk metadata exposed to the walkthrough generator and renderer. */
export const WalkthroughHunkDigest = Schema.Struct({
  id: WalkthroughHunkId,
  path: RepositoryRelativePath,
  header: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  synthetic: Schema.Boolean,
})

/** Deterministic hunk metadata exposed to the walkthrough generator and renderer. */
export type WalkthroughHunkDigest = typeof WalkthroughHunkDigest.Type

/** Prompt input prepared from a parsed diff after filtering and size bounding. */
export interface WalkthroughPromptInput {
  readonly diff: string
  readonly hunkDigest: readonly WalkthroughHunkDigest[]
  readonly stats: WalkthroughPromptStats
  readonly changedFileTree: string
  readonly generation: WalkthroughGenerationDetails
}

/** Safety budget for preparing walkthrough prompt input. */
export interface WalkthroughPromptBudget {
  readonly maxDiffChars: number
  readonly maxFiles: number
  readonly maxHunks: number
  readonly maxLinesPerHunk: number
}

/** Summary of prompt filtering and truncation applied before generation. */
export const WalkthroughPromptStats = Schema.Struct({
  totalFiles: Schema.Number,
  selectedFiles: Schema.Number,
  hiddenFiles: Schema.Number,
  omittedFiles: Schema.Number,
  totalHunks: Schema.Number,
  selectedHunks: Schema.Number,
  omittedHunks: Schema.Number,
  truncatedHunks: Schema.Number,
  truncatedByCharBudget: Schema.Boolean,
  usedHiddenFallback: Schema.Boolean,
})

/** Summary of prompt filtering and truncation applied before generation. */
export type WalkthroughPromptStats = typeof WalkthroughPromptStats.Type

/** Review scope segment used in deterministic hunk IDs for one exact hosted review. */
export const walkthroughHostedReviewScope = (review: HostedReviewLocator) =>
  `hosted-review:${makeHostedReviewKey(review)}`

/** Review scope segment used in deterministic hunk IDs for local working tree changes. */
export const walkthroughLocalDiffScope = (headSha: ReviewRevisionType) => `local-diff:${headSha}`

/** Stable walkthrough scope for one immutable repository comparison. */
export const walkthroughRepositoryComparisonScope = (reviewKey: ReviewKeyType) =>
  `repository-comparison:${reviewKey}`

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
  const hiddenFiles = files.filter((file) => DiffFileVisibility.guards.Hidden(file.visibility))
  const visibleFiles = files.filter((file) => DiffFileVisibility.guards.Visible(file.visibility))
  const usedHiddenFallback = visibleFiles.length === 0 && files.length > 0
  const candidateFiles = usedHiddenFallback ? files : visibleFiles
  const totalHunks = files.reduce((total, file) => total + fileReviewUnitCount(file), 0)
  const candidateHunks = candidateFiles.reduce(
    (total, file) => total + fileReviewUnitCount(file),
    0,
  )
  const standard = preparePromptCandidates(candidateFiles, scope, validBudget)
  const useSampledTree =
    isVeryLargeDiff(files) ||
    candidateFiles.length > validBudget.maxFiles ||
    candidateHunks > validBudget.maxHunks ||
    standard.truncatedByCharBudget ||
    standard.selectedFilePaths.size < candidateFiles.length ||
    standard.hunkDigest.length < candidateHunks
  const prepared = useSampledTree
    ? preparePromptCandidates(sampleFilesByFolder(candidateFiles), scope, validBudget)
    : standard

  if (prepared.hunkDigest.length === 0) {
    return WalkthroughPromptPreparationError.make({
      message: "Cannot generate a walkthrough because the diff has no reviewable changes.",
      details: [
        `Parsed ${files.length} changed file${files.length === 1 ? "" : "s"}.`,
        `Parsed ${totalHunks} review unit${totalHunks === 1 ? "" : "s"}.`,
      ],
    })
  }

  const analyzedFiles = files.filter((file) => prepared.selectedFilePaths.has(file.path))
  const generation = WalkthroughGenerationDetails.make({
    mode: useSampledTree ? "sampled-tree" : "standard",
    totalFiles: files.length,
    analyzedFiles: analyzedFiles.length,
    totalFolders: countFolders(files),
    analyzedFolders: countFolders(analyzedFiles),
  })

  return Effect.succeed({
    diff: prepared.chunks.join("\n\n"),
    hunkDigest: prepared.hunkDigest,
    changedFileTree: useSampledTree ? buildChangedFileTree(files) : "",
    generation,
    stats: {
      hiddenFiles: hiddenFiles.length,
      omittedFiles: Math.max(0, files.length - prepared.selectedFilePaths.size),
      omittedHunks: Math.max(0, totalHunks - prepared.hunkDigest.length),
      selectedFiles: prepared.selectedFilePaths.size,
      selectedHunks: prepared.hunkDigest.length,
      totalFiles: files.length,
      totalHunks,
      truncatedByCharBudget: prepared.truncatedByCharBudget,
      truncatedHunks: prepared.truncatedHunks,
      usedHiddenFallback,
    },
  })
}

/**
 * Decodes generated walkthrough output, validates hunk references, and adds omitted hunks to Support.
 */
export const validateWalkthrough = <Input>(
  input: Input,
  hunkDigest: readonly WalkthroughHunkDigest[],
): Effect.Effect<Walkthrough, WalkthroughValidationError> =>
  Schema.decodeUnknownEffect(Walkthrough)(normalizeWalkthroughInput(input)).pipe(
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
  hunkIds: readonly WalkthroughHunkId[],
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
    const hunks = selectedHunks.map((entry) => entry.hunk)

    return [
      Schema.decodeSync(ParsedDiffFile)({
        ...file,
        patchHash: makeReviewFilePatchHash({
          hunks,
          oldPath: file.oldPath,
          path: file.path,
          status: file.status,
        }),
        reviewKey: ReviewKey.make(
          `${file.reviewKey}:${selectedHunks.map((entry) => entry.id).join(",")}`,
        ),
        additions,
        deletions,
        hunks,
        patch,
      }),
    ]
  })
}

/** Summarizes selected hunk IDs into path-level line totals for sidebar rows. */
export const summarizeWalkthroughHunksByPath = (
  hunkDigest: readonly WalkthroughHunkDigest[],
  hunkIds: readonly WalkthroughHunkId[],
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

  return order.map((path) => totalsByPath.get(path)).filter(Predicate.isNotUndefined)
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

interface PreparedPromptCandidates {
  readonly chunks: readonly string[]
  readonly hunkDigest: readonly WalkthroughHunkDigest[]
  readonly selectedFilePaths: ReadonlySet<string>
  readonly truncatedByCharBudget: boolean
  readonly truncatedHunks: number
}

const preparePromptCandidates = (
  files: readonly ParsedDiffFile[],
  scope: string,
  budget: WalkthroughPromptBudget,
): PreparedPromptCandidates => {
  const chunks: string[] = []
  const hunkDigest: WalkthroughHunkDigest[] = []
  const selectedFilePaths = new Set<string>()
  let truncatedHunks = 0
  let truncatedByCharBudget = false

  for (const file of files) {
    if (selectedFilePaths.size >= budget.maxFiles) break
    const entries = filePromptEntries(file, scope)
    let selectedFile = false

    for (const entry of entries) {
      if (hunkDigest.length >= budget.maxHunks) break

      const alias = makeWalkthroughHunkAlias(hunkDigest.length)
      const excerpt = promptExcerptForEntry(file, entry, alias, budget.maxLinesPerHunk)
      const nextDiff = appendPromptChunk(chunks, excerpt)
      if (nextDiff.length > budget.maxDiffChars) {
        truncatedByCharBudget = true
        if (hunkDigest.length === 0) {
          const truncatedExcerpt = truncateText(excerpt, budget.maxDiffChars)
          chunks.push(truncatedExcerpt.text)
          truncatedHunks += truncatedExcerpt.truncated ? 1 : 0
          hunkDigest.push(entry.digest)
          selectedFile = true
        }
        break
      }

      chunks.push(excerpt.text)
      hunkDigest.push(entry.digest)
      selectedFile = true
      if (excerpt.truncated) truncatedHunks += 1
    }

    if (selectedFile) selectedFilePaths.add(file.path)
    if (hunkDigest.length >= budget.maxHunks || truncatedByCharBudget) break
  }

  return {
    chunks,
    hunkDigest,
    selectedFilePaths,
    truncatedByCharBudget,
    truncatedHunks,
  }
}

const sampleFilesByFolder = (files: readonly ParsedDiffFile[]): readonly ParsedDiffFile[] => {
  const filesByFolder = new Map<string, ParsedDiffFile[]>()
  for (const file of files) {
    const folder = folderPath(file.path)
    const folderFiles = filesByFolder.get(folder) ?? []
    folderFiles.push(file)
    filesByFolder.set(folder, folderFiles)
  }

  const primaryFiles: ParsedDiffFile[] = []
  const supportingFiles: ParsedDiffFile[] = []
  // oxlint-disable-next-line unicorn/no-array-sort -- Sort a copied key list for stable sampling.
  for (const folder of [...filesByFolder.keys()].sort()) {
    // oxlint-disable-next-line unicorn/no-array-sort -- Sort a copied file list without mutating input.
    const folderFiles = [...(filesByFolder.get(folder) ?? [])].sort(compareRepresentativeFiles)
    const primary =
      folderFiles.find((file) => !isSupportingRepresentative(file.path)) ?? folderFiles[0]
    if (primary === undefined) continue
    primaryFiles.push(primary)

    const supporting = folderFiles.find(
      (file) => file.path !== primary.path && isSupportingRepresentative(file.path),
    )
    if (supporting !== undefined) supportingFiles.push(supporting)
  }

  return [...primaryFiles, ...supportingFiles]
}

const compareRepresentativeFiles = (left: ParsedDiffFile, right: ParsedDiffFile) =>
  changedLineCount(right) - changedLineCount(left) ||
  right.patch.length - left.patch.length ||
  left.path.localeCompare(right.path)

const isSupportingRepresentative = (path: string) =>
  /(?:^|\/)(?:__tests__|docs?|fixtures?|tests?)(?:\/|$)|\.(?:spec|test)\.[^/]+$|(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|vite\.config\.[^/]+)$/i.test(
    path,
  )

const folderPath = (path: string) => reviewPathDirectory(path) ?? "(root)"

const countFolders = (files: readonly ParsedDiffFile[]) =>
  new Set(files.map((file) => folderPath(file.path))).size

const buildChangedFileTree = (files: readonly ParsedDiffFile[]) => {
  const filesByFolder = new Map<string, ParsedDiffFile[]>()
  for (const file of files) {
    const folder = folderPath(file.path)
    const folderFiles = filesByFolder.get(folder) ?? []
    folderFiles.push(file)
    filesByFolder.set(folder, folderFiles)
  }

  const folderSummaries: string[] = []
  const treeLines: string[] = []
  // oxlint-disable-next-line unicorn/no-array-sort -- Sort a copied key list for stable prompt output.
  for (const folder of [...filesByFolder.keys()].sort()) {
    // oxlint-disable-next-line unicorn/no-array-sort -- Sort a copied file list without mutating input.
    const folderFiles = [...(filesByFolder.get(folder) ?? [])].sort((left, right) =>
      left.path.localeCompare(right.path),
    )
    const additions = folderFiles.reduce((total, file) => total + file.additions, 0)
    const deletions = folderFiles.reduce((total, file) => total + file.deletions, 0)
    const summary = `${folder} (${folderFiles.length} files, +${additions} -${deletions})`
    folderSummaries.push(summary)
    treeLines.push(summary, ...folderFiles.map((file) => `  ${file.path}`))
  }

  const completeTree = treeLines.join("\n")
  if (completeTree.length <= MAX_SAMPLED_FILE_TREE_CHARS) return completeTree

  const compactTree = folderSummaries.join("\n")
  if (compactTree.length <= MAX_SAMPLED_FILE_TREE_CHARS) {
    return `${compactTree}\n[File paths omitted to keep the changed-folder tree bounded.]`
  }
  const marker = "\n[Changed-folder tree truncated to fit the prompt budget.]"
  return `${compactTree.slice(0, MAX_SAMPLED_FILE_TREE_CHARS - marker.length)}${marker}`
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
  const seenIds = new Set<WalkthroughHunkId>()
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
          id: WalkthroughSupportItemId.make("support-omitted-hunks"),
          title: "Other changes",
          reason: "Not included in the generated walkthrough.",
          hunkIds: [...omittedIds],
        }),
      ],
    }),
  )
}

const normalizeWalkthroughInput = <Input>(input: Input) => {
  if (!Predicate.isReadonlyObject(input)) return input
  if ("support" in input && input.support !== undefined) return input
  return { ...input, support: [] }
}

const validateHunkIdList = (
  hunkIds: readonly WalkthroughHunkId[],
  label: string,
  expectedIds: ReadonlySet<WalkthroughHunkId>,
  omittedIds: Set<WalkthroughHunkId>,
  seenIds: Set<WalkthroughHunkId>,
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

const walkthroughHunkId = (path: string, scope: string, ordinal: number): WalkthroughHunkId =>
  WalkthroughHunkId.make(`${path}:${scope}:h${ordinal}`)

/** Builds the compact hunk alias used by walkthrough prompts and provider responses. */
export const makeWalkthroughHunkAlias = (index: number) => `h${index + 1}`

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
