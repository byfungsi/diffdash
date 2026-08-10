import { Effect, Schema } from "effect"

import {
  BranchRevision,
  ChangedFile,
  HostedReviewDetail,
  HostedReviewDiff,
  HostedReviewSummary,
  HostedRepositorySource,
  ProviderActor,
  ReviewCommit,
  makeHostedReviewLocator,
  makeHostedRepositoryLocator,
} from "@diffdash/domain/git-provider"
import { RemoteOnly, Repo, RepositorySearchScope } from "@diffdash/domain/repository"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { WebUrl } from "@diffdash/domain/web-url"
import type { ParsedDiff } from "@diffdash/domain/diff"
import { findProjectedDiffHunkLine, projectDiffHunkLines } from "@diffdash/domain/diff-hunk-lines"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { HostedReviewSnapshot } from "@diffdash/domain/review-context"
import {
  makeReviewDiffIdentity,
  makeReviewKey,
  makeReviewSnapshotId,
  ReviewProjectId,
  ReviewRevision,
  type ReviewKey,
} from "@diffdash/domain/review-identity"
import {
  ReviewAgentProgress,
  ReviewAgentProgressStage,
  ReviewThreadAgentResponse,
} from "@diffdash/domain/review-agent"
import {
  CurrentReviewAnchor,
  isReviewAnchorInParsedDiff,
  LineReviewAnchor,
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
} from "@diffdash/domain/review-thread"
import { makeDemoReviewTurn, validateDemoReviewMessage } from "./review-thread-fixtures"
import {
  buildWalkthroughHunkDigest,
  StoredWalkthrough,
  validateWalkthrough,
  WALKTHROUGH_PROMPT_VERSION,
  Walkthrough,
  walkthroughHostedReviewScope,
  WalkthroughChapter,
  WalkthroughChapterId,
  WalkthroughStop,
  WalkthroughStopId,
  WalkthroughSupportItem,
  WalkthroughSupportItemId,
  type WalkthroughHunkDigest,
} from "@diffdash/domain/walkthrough"

/** Stable locator for an authored walkthrough hunk before parser IDs are derived. */
export class DemoHunkLocator extends Schema.Class<DemoHunkLocator>("DemoHunkLocator")({
  path: RepositoryRelativePath,
  ordinal: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
}) {}

/** Stable locator for an authored line thread before its exact anchor is derived. */
export class DemoLineLocator extends Schema.Class<DemoLineLocator>("DemoLineLocator")({
  path: RepositoryRelativePath,
  side: Schema.Literals(["old", "new"]),
  lineNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  lineContent: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
}) {}

/** One authored walkthrough stop using semantic hunk locators. */
export class DemoWalkthroughStopSource extends Schema.Class<DemoWalkthroughStopSource>(
  "DemoWalkthroughStopSource",
)({
  id: WalkthroughStopId,
  title: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  summary: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  risk: Schema.Literals(["critical", "review", "support"]),
  hunks: Schema.Array(DemoHunkLocator),
}) {}

/** One authored walkthrough chapter using semantic hunk locators. */
export class DemoWalkthroughChapterSource extends Schema.Class<DemoWalkthroughChapterSource>(
  "DemoWalkthroughChapterSource",
)({
  id: WalkthroughChapterId,
  title: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  summary: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  stops: Schema.Array(DemoWalkthroughStopSource),
}) {}

/** One authored lower-priority walkthrough item. */
export class DemoWalkthroughSupportSource extends Schema.Class<DemoWalkthroughSupportSource>(
  "DemoWalkthroughSupportSource",
)({
  id: WalkthroughSupportItemId,
  title: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  reason: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  hunks: Schema.Array(DemoHunkLocator),
}) {}

/** Human-maintained walkthrough source resolved against one parsed revision. */
export class DemoWalkthroughSource extends Schema.Class<DemoWalkthroughSource>(
  "DemoWalkthroughSource",
)({
  title: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  summary: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  chapters: Schema.Array(DemoWalkthroughChapterSource),
  support: Schema.Array(DemoWalkthroughSupportSource),
}) {}

const DemoReviewRevision = ReviewRevision.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{40}$/)))

/** Authored commit metadata for a demo revision. */
export class DemoCommitSource extends Schema.Class<DemoCommitSource>("DemoCommitSource")({
  oid: DemoReviewRevision,
  messageHeadline: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  authoredDate: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
}) {}

/** Manifest entry for one coherent demo pull-request revision. */
export class DemoRevisionManifest extends Schema.Class<DemoRevisionManifest>(
  "DemoRevisionManifest",
)({
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  baseSha: DemoReviewRevision,
  headSha: DemoReviewRevision,
  fetchedAt: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  updatedAt: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  diffAsset: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  walkthroughAsset: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  commits: Schema.Array(DemoCommitSource),
}) {}

/** Authored repository identity and workspace metadata. */
export class DemoRepositorySource extends Schema.Class<DemoRepositorySource>(
  "DemoRepositorySource",
)({
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  owner: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  description: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  remoteUrl: WebUrl,
  createdAt: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
}) {}

/** Authored pull-request metadata shared by every revision. */
export class DemoPullRequestSource extends Schema.Class<DemoPullRequestSource>(
  "DemoPullRequestSource",
)({
  number: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  title: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  body: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  author: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  state: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  isDraft: Schema.Boolean,
  baseRefName: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  headRefName: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  createdAt: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
}) {}

/** One authored message in a reusable local review thread. */
export class DemoThreadMessageSource extends Schema.Class<DemoThreadMessageSource>(
  "DemoThreadMessageSource",
)({
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  author: Schema.Literals(["user", "agent"]),
  bodyMarkdown: Schema.String,
  status: Schema.Literals(["pending", "complete", "failed"]),
  agentRunId: Schema.NullOr(Schema.String),
  createdAt: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  updatedAt: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
}) {}

/** Authored thread carried from one demo revision to another. */
export class DemoThreadSource extends Schema.Class<DemoThreadSource>("DemoThreadSource")({
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  originalRevisionId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  currentRevisionId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  anchorState: Schema.Literals(["Active", "Outdated", "Unresolved"]),
  locator: DemoLineLocator,
  createdAt: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  updatedAt: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  messages: Schema.Array(DemoThreadMessageSource),
}) {}

/** One timed progress stage in a scripted agent turn. */
export class DemoAgentProgressSource extends Schema.Class<DemoAgentProgressSource>(
  "DemoAgentProgressSource",
)({
  afterMs: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  stage: ReviewAgentProgressStage,
}) {}

/** Authored provider-neutral response and progress for a demo thread turn. */
export class DemoAgentTurnSource extends Schema.Class<DemoAgentTurnSource>("DemoAgentTurnSource")({
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  threadId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  agentRunId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  responseBodyMarkdown: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  threadSummaryUpdate: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  progress: Schema.Array(DemoAgentProgressSource),
}) {}

/** Complete human-authored manifest for one reusable product demo scenario. */
export class DemoScenarioManifest extends Schema.Class<DemoScenarioManifest>(
  "DemoScenarioManifest",
)({
  schemaVersion: Schema.Literal(1),
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  title: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  appVersion: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  locale: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  timezone: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  theme: Schema.Literals(["light", "dark"]),
  currentRevisionId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  repository: DemoRepositorySource,
  pullRequest: DemoPullRequestSource,
  searchScopes: Schema.Array(
    Schema.Struct({
      login: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
      kind: Schema.Literals(["user", "organization"]),
    }),
  ),
  revisions: Schema.Array(DemoRevisionManifest),
  threads: Schema.Array(DemoThreadSource),
  agentTurns: Schema.Array(DemoAgentTurnSource),
  initiallyViewedFilePaths: Schema.Array(RepositoryRelativePath),
}) {}

/** Resolved text assets used to materialize a scenario without network or filesystem access. */
export interface DemoScenarioAssets {
  readonly diffs: Readonly<Record<string, string>>
  readonly walkthroughs: {
    readonly [assetName: string]: DemoWalkthroughSource
  }
}

/** One coherent, fully materialized pull-request revision. */
export interface MaterializedDemoRevision {
  readonly id: string
  readonly detail: HostedReviewDetail
  readonly diff: HostedReviewDiff
  readonly parsedDiff: ParsedDiff
  readonly snapshot: HostedReviewSnapshot
  readonly walkthrough: StoredWalkthrough
}

/** Product-ready scenario data consumed by demo APIs, captures, and integration tests. */
export interface MaterializedDemoScenario {
  readonly manifest: DemoScenarioManifest
  readonly repository: Repo
  readonly searchScopes: readonly RepositorySearchScope[]
  readonly reviewKey: ReviewKey
  readonly revisions: readonly MaterializedDemoRevision[]
  readonly currentRevision: MaterializedDemoRevision
  readonly threads: readonly ReviewThreadDetails[]
  readonly agentTurns: Readonly<
    Record<
      string,
      {
        readonly response: ReviewThreadAgentResponse
        readonly progress: readonly {
          readonly afterMs: number
          readonly event: ReviewAgentProgress
        }[]
      }
    >
  >
}

/** Recoverable validation failure while decoding or materializing a demo scenario. */
export class DemoScenarioValidationError extends Schema.TaggedError<DemoScenarioValidationError>()(
  "DemoScenarioValidationError",
  {
    scenarioId: Schema.String,
    details: Schema.Array(Schema.String),
  },
) {}

/** Decodes a JSON asset through the supplied Effect schema. */
export const decodeDemoJson = <A, I>(
  scenarioId: string,
  assetName: string,
  schema: Schema.Codec<A, I>,
  source: string,
): Effect.Effect<A, DemoScenarioValidationError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(source).pipe(
    Effect.mapError(() =>
      DemoScenarioValidationError.make({
        scenarioId,
        details: [`${assetName} is not valid JSON or does not match its required schema.`],
      }),
    ),
  )

/** Materializes one decoded manifest through production parsers and domain schemas. */
export const materializeDemoScenario = (
  manifest: DemoScenarioManifest,
  assets: DemoScenarioAssets,
): Effect.Effect<MaterializedDemoScenario, DemoScenarioValidationError> =>
  Effect.gen(function* () {
    const manifestErrors = validateManifest(manifest)
    if (manifestErrors.length > 0) return yield* scenarioFailure(manifest.id, manifestErrors)
    const reviewKey = makeReviewKey(
      makeHostedReviewLocator(
        "github",
        manifest.repository.owner,
        manifest.repository.name,
        manifest.pullRequest.number,
      ),
    )
    const repository = Repo.make({
      id: ReviewProjectId.make(manifest.repository.id),
      source: HostedRepositorySource.make({
        locator: makeHostedRepositoryLocator(
          "github",
          manifest.repository.owner,
          manifest.repository.name,
        ),
      }),
      checkout: RemoteOnly.make({ remoteUrl: manifest.repository.remoteUrl }),
      isFavorite: true,
      lastOpenedAt: manifest.pullRequest.createdAt,
      lastSyncedAt: manifest.pullRequest.createdAt,
      createdAt: manifest.repository.createdAt,
      updatedAt: manifest.pullRequest.createdAt,
    })
    const revisions = yield* Effect.forEach(manifest.revisions, (revision) =>
      materializeRevision(manifest, repository, reviewKey, revision, assets),
    )
    const revisionById = new Map(revisions.map((revision) => [revision.id, revision]))
    const currentRevision = revisionById.get(manifest.currentRevisionId)
    if (currentRevision === undefined) {
      return yield* scenarioFailure(manifest.id, [
        `Current revision ${manifest.currentRevisionId} does not exist.`,
      ])
    }
    const currentPaths = new Set(currentRevision.parsedDiff.files.map((file) => file.path))
    const missingViewedPaths = manifest.initiallyViewedFilePaths.filter(
      (path) => !currentPaths.has(path),
    )
    if (missingViewedPaths.length > 0) {
      return yield* scenarioFailure(
        manifest.id,
        missingViewedPaths.map((path) => `Initially viewed file ${path} does not exist.`),
      )
    }
    const threads = yield* Effect.forEach(manifest.threads, (thread) =>
      materializeThread(manifest, reviewKey, revisionById, thread),
    )
    const threadIds = new Set(threads.map(({ thread }) => thread.id))
    const agentTurns = yield* Effect.forEach(manifest.agentTurns, (turn) => {
      const threadId = ReviewThreadId.make(turn.threadId)
      if (!threadIds.has(threadId)) {
        return scenarioFailure(manifest.id, [
          `Agent turn ${turn.id} references unknown thread ${turn.threadId}.`,
        ])
      }
      const thread = threads.find((candidate) => candidate.thread.id === threadId)
      const persistedResponse = thread?.conversation.find(
        (entry) => entry._tag === "Completed" && entry.run.id === turn.agentRunId,
      )
      if (
        persistedResponse?._tag !== "Completed" ||
        persistedResponse.message.bodyMarkdown !== turn.responseBodyMarkdown
      ) {
        return scenarioFailure(manifest.id, [
          `Agent turn ${turn.id} does not match persisted run ${turn.agentRunId}.`,
        ])
      }
      return Effect.succeed([
        turn.id,
        {
          response: ReviewThreadAgentResponse.make({
            bodyMarkdown: turn.responseBodyMarkdown,
            threadSummaryUpdate: turn.threadSummaryUpdate,
            referencedAnchors: [],
          }),
          progress: turn.progress.map((progress) => ({
            afterMs: progress.afterMs,
            event: ReviewAgentProgress.make({ threadId, stage: progress.stage }),
          })),
        },
      ] as const)
    })

    return {
      manifest,
      repository,
      searchScopes: manifest.searchScopes.map((scope) => RepositorySearchScope.make(scope)),
      reviewKey,
      revisions,
      currentRevision,
      threads,
      agentTurns: Object.fromEntries(agentTurns),
    }
  })

const materializeRevision = (
  manifest: DemoScenarioManifest,
  repository: Repo,
  reviewKey: ReviewKey,
  revision: DemoRevisionManifest,
  assets: DemoScenarioAssets,
): Effect.Effect<MaterializedDemoRevision, DemoScenarioValidationError> =>
  Effect.gen(function* () {
    const rawDiff = assets.diffs[revision.diffAsset]
    const walkthroughSource = assets.walkthroughs[revision.walkthroughAsset]
    const missingAssets = [
      ...(rawDiff === undefined ? [`Missing diff asset ${revision.diffAsset}.`] : []),
      ...(walkthroughSource === undefined
        ? [`Missing walkthrough asset ${revision.walkthroughAsset}.`]
        : []),
    ]
    if (missingAssets.length > 0) return yield* scenarioFailure(manifest.id, missingAssets)

    const parsedDiff = parseUnifiedDiff(rawDiff ?? "")
    if (parsedDiff.files.length === 0) {
      return yield* scenarioFailure(manifest.id, [
        `Revision ${revision.id} does not contain any parsed files.`,
      ])
    }
    const files = parsedDiff.files.map((file) =>
      ChangedFile.make({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status,
      }),
    )
    const locator = makeHostedReviewLocator(
      "github",
      manifest.repository.owner,
      manifest.repository.name,
      manifest.pullRequest.number,
    )
    const summary = HostedReviewSummary.make({
      locator,
      title: manifest.pullRequest.title,
      body: manifest.pullRequest.body,
      author: ProviderActor.make({
        id: null,
        username: manifest.pullRequest.author,
        displayName: null,
        avatarUrl: null,
      }),
      state: manifest.pullRequest.state,
      decision: "none",
      url: WebUrl.make(`${repository.remoteUrl}/pull/${manifest.pullRequest.number}`),
      draft: manifest.pullRequest.isDraft,
      base: BranchRevision.make({
        name: RepositoryComparisonRef.make(manifest.pullRequest.baseRefName),
        revision: revision.baseSha,
      }),
      head: BranchRevision.make({
        name: RepositoryComparisonRef.make(manifest.pullRequest.headRefName),
        revision: revision.headSha,
      }),
      createdAt: manifest.pullRequest.createdAt,
      updatedAt: revision.updatedAt,
    })
    const detail = HostedReviewDetail.make({
      summary,
      files,
      commits: revision.commits.map((commit) =>
        ReviewCommit.make({
          revision: commit.oid,
          title: commit.messageHeadline,
          authoredAt: commit.authoredDate,
        }),
      ),
    })
    const diff = HostedReviewDiff.make({
      locator,
      headRevision: revision.headSha,
      diff: rawDiff ?? "",
      fetchedAt: revision.fetchedAt,
    })
    const scope = walkthroughHostedReviewScope(locator)
    const hunkDigest = buildWalkthroughHunkDigest(parsedDiff.files, scope)
    const source = yield* Schema.decodeUnknownEffect(DemoWalkthroughSource)(walkthroughSource).pipe(
      Effect.mapError(() =>
        DemoScenarioValidationError.make({
          scenarioId: manifest.id,
          details: [`Walkthrough ${revision.walkthroughAsset} has an invalid shape.`],
        }),
      ),
    )
    const walkthrough = yield* materializeWalkthrough(manifest.id, source, hunkDigest)
    const storedWalkthrough = StoredWalkthrough.make({
      repoId: repository.id,
      prNumber: manifest.pullRequest.number,
      reviewKey,
      baseSha: ReviewRevision.make(revision.baseSha),
      headSha: ReviewRevision.make(revision.headSha),
      promptVersion: WALKTHROUGH_PROMPT_VERSION,
      walkthrough,
      createdAt: revision.fetchedAt,
    })
    const baseRevision = ReviewRevision.make(revision.baseSha)
    const headRevision = ReviewRevision.make(revision.headSha)
    const snapshot = HostedReviewSnapshot.make({
      snapshotId: makeReviewSnapshotId({
        reviewKey,
        baseRevision,
        headRevision,
        diffIdentity: makeReviewDiffIdentity(diff.diff),
      }),
      reviewKey,
      baseRevision,
      headRevision,
      detail,
      diff,
      parsedDiff,
    })

    return { id: revision.id, detail, diff, parsedDiff, snapshot, walkthrough: storedWalkthrough }
  })

const materializeWalkthrough = (
  scenarioId: string,
  source: DemoWalkthroughSource,
  hunkDigest: readonly WalkthroughHunkDigest[],
): Effect.Effect<Walkthrough, DemoScenarioValidationError> => {
  const hunkIds = (locators: readonly DemoHunkLocator[]) =>
    Effect.forEach(locators, (locator) => {
      const matches = hunkDigest.filter((hunk) => hunk.path === locator.path)
      const match = matches[locator.ordinal - 1]
      return match === undefined
        ? scenarioFailure(scenarioId, [
            `Walkthrough locator ${locator.path} h${locator.ordinal} does not exist.`,
          ])
        : Effect.succeed(match.id)
    })

  return Effect.gen(function* () {
    const chapters = yield* Effect.forEach(source.chapters, (chapter) =>
      Effect.gen(function* () {
        const stops = yield* Effect.forEach(chapter.stops, (stop) =>
          Effect.map(hunkIds(stop.hunks), (resolvedHunkIds) =>
            WalkthroughStop.make({ ...stop, hunkIds: resolvedHunkIds }),
          ),
        )
        return WalkthroughChapter.make({ ...chapter, stops })
      }),
    )
    const support = yield* Effect.forEach(source.support, (item) =>
      Effect.map(hunkIds(item.hunks), (resolvedHunkIds) =>
        WalkthroughSupportItem.make({ ...item, hunkIds: resolvedHunkIds }),
      ),
    )
    const authored = Walkthrough.make({
      title: source.title,
      summary: source.summary,
      chapters,
      support,
    })
    return yield* validateWalkthrough(authored, hunkDigest).pipe(
      Effect.mapError((error) =>
        DemoScenarioValidationError.make({
          scenarioId,
          details: error.details,
        }),
      ),
    )
  })
}

const materializeThread = (
  manifest: DemoScenarioManifest,
  reviewKey: ReviewKey,
  revisionById: ReadonlyMap<string, MaterializedDemoRevision>,
  source: DemoThreadSource,
): Effect.Effect<ReviewThreadDetails, DemoScenarioValidationError> =>
  Effect.gen(function* () {
    const originalRevision = revisionById.get(source.originalRevisionId)
    const currentRevision = revisionById.get(source.currentRevisionId)
    if (originalRevision === undefined || currentRevision === undefined) {
      return yield* scenarioFailure(manifest.id, [
        `Thread ${source.id} references a missing original or current revision.`,
      ])
    }
    const originalAnchor = yield* resolveLineAnchor(
      manifest.id,
      originalRevision.parsedDiff,
      source.locator,
    )
    const activeAnchor =
      source.anchorState === "Active"
        ? yield* resolveLineAnchor(manifest.id, currentRevision.parsedDiff, source.locator)
        : null
    if (!isReviewAnchorInParsedDiff(originalAnchor, originalRevision.parsedDiff)) {
      return yield* scenarioFailure(manifest.id, [
        `Thread ${source.id} original anchor does not match revision ${source.originalRevisionId}.`,
      ])
    }
    if (
      activeAnchor !== null &&
      !isReviewAnchorInParsedDiff(activeAnchor, currentRevision.parsedDiff)
    ) {
      return yield* scenarioFailure(manifest.id, [
        `Thread ${source.id} current anchor does not match revision ${source.currentRevisionId}.`,
      ])
    }
    const threadId = ReviewThreadId.make(source.id)
    const expectedSequences = source.messages.map((_, index) => index)
    if (source.messages.some((message, index) => message.sequence !== expectedSequences[index])) {
      return yield* scenarioFailure(manifest.id, [
        `Thread ${source.id} message sequences must start at zero and remain contiguous.`,
      ])
    }

    const thread = ReviewThread.make({
      id: threadId,
      repoId: ReviewProjectId.make(manifest.repository.id),
      reviewKey,
      prNumber: manifest.pullRequest.number,
      baseRevision: originalRevision.snapshot.baseRevision,
      headRevision: originalRevision.snapshot.headRevision,
      currentBaseRevision: currentRevision.snapshot.baseRevision,
      currentHeadRevision: currentRevision.snapshot.headRevision,
      originalAnchor,
      currentAnchor:
        activeAnchor !== null
          ? CurrentReviewAnchor.cases.Active.make({ anchor: activeAnchor })
          : source.anchorState === "Outdated"
            ? CurrentReviewAnchor.cases.Outdated.make({})
            : CurrentReviewAnchor.cases.Unresolved.make({}),
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    })
    const lifecycleErrors = source.messages.flatMap((message) => {
      const error = validateDemoReviewMessage(message)
      return error === null ? [] : [error]
    })
    if (lifecycleErrors.length > 0) return yield* scenarioFailure(manifest.id, lifecycleErrors)
    return ReviewThreadDetails.make({
      thread,
      conversation: source.messages.map((message) => makeDemoReviewTurn(thread, message)),
    })
  })

const resolveLineAnchor = (
  scenarioId: string,
  parsedDiff: ParsedDiff,
  locator: DemoLineLocator,
): Effect.Effect<LineReviewAnchor, DemoScenarioValidationError> => {
  const file = parsedDiff.files.find((candidate) => candidate.path === locator.path)
  if (file === undefined) {
    return scenarioFailure(scenarioId, [`Thread file ${locator.path} does not exist.`])
  }
  for (const hunk of file.hunks) {
    if (hunkContainsLocator(hunk, locator)) {
      return Effect.succeed(
        LineReviewAnchor.make({
          fileId: file.fileId,
          filePath: file.path,
          oldPath: file.oldPath,
          hunkId: hunk.id,
          hunkFingerprint: hunk.fingerprint,
          hunkHeader: hunk.header,
          side: locator.side,
          lineNumber: locator.lineNumber,
          lineContent: locator.lineContent,
        }),
      )
    }
  }
  return scenarioFailure(scenarioId, [
    `Thread line ${locator.path}:${locator.side}:${locator.lineNumber} does not match the diff.`,
  ])
}

const hunkContainsLocator = (
  hunk: ParsedDiff["files"][number]["hunks"][number],
  locator: DemoLineLocator,
) =>
  findProjectedDiffHunkLine(projectDiffHunkLines(hunk), {
    side: locator.side,
    lineNumber: locator.lineNumber,
    content: locator.lineContent,
  }) !== null

const validateManifest = (manifest: DemoScenarioManifest) => {
  const details: string[] = []
  const expectedRepositoryId = `github:${manifest.repository.owner}/${manifest.repository.name}`
  if (manifest.repository.id !== expectedRepositoryId) {
    details.push(`Repository ID must be ${expectedRepositoryId}.`)
  }
  validateUniqueValues(
    manifest.revisions.map((revision) => revision.id),
    "revision ID",
    details,
  )
  validateUniqueValues(
    manifest.revisions.map((revision) => revision.headSha),
    "revision head SHA",
    details,
  )
  validateUniqueValues(
    manifest.threads.map((thread) => thread.id),
    "thread ID",
    details,
  )
  validateUniqueValues(
    manifest.agentTurns.map((turn) => turn.id),
    "agent turn ID",
    details,
  )
  const timestamps = [
    ["repository.createdAt", manifest.repository.createdAt],
    ["pullRequest.createdAt", manifest.pullRequest.createdAt],
    ...manifest.revisions.flatMap(
      (revision) =>
        [
          [`revision.${revision.id}.fetchedAt`, revision.fetchedAt],
          [`revision.${revision.id}.updatedAt`, revision.updatedAt],
          ...revision.commits.map(
            (commit) => [`commit.${commit.oid}.authoredDate`, commit.authoredDate] as const,
          ),
        ] as const,
    ),
    ...manifest.threads.flatMap(
      (thread) =>
        [
          [`thread.${thread.id}.createdAt`, thread.createdAt],
          [`thread.${thread.id}.updatedAt`, thread.updatedAt],
          ...thread.messages.flatMap(
            (message) =>
              [
                [`message.${message.id}.createdAt`, message.createdAt],
                [`message.${message.id}.updatedAt`, message.updatedAt],
              ] as const,
          ),
        ] as const,
    ),
  ] as const
  for (const [label, timestamp] of timestamps) {
    if (!isUtcIsoTimestamp(timestamp)) details.push(`${label} must be a valid UTC timestamp.`)
  }
  return details
}

const validateUniqueValues = (values: readonly string[], label: string, details: string[]) => {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) details.push(`Duplicate ${label}: ${value}.`)
    seen.add(value)
  }
}

const isUtcIsoTimestamp = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
  !Number.isNaN(Date.parse(value))

const scenarioFailure = (scenarioId: string, details: readonly string[]) =>
  Effect.fail(
    DemoScenarioValidationError.make({
      scenarioId,
      details: [...details],
    }),
  )
