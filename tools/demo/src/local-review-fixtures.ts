import { ChangedFile } from "@diffdash/domain/git-provider"
import type { ParsedDiff } from "@diffdash/domain/diff"
import {
  BranchComparison,
  LocalReviewDetail,
  LocalReviewDiff,
  LocalReviewTarget,
  workingTreeReviewTarget,
} from "@diffdash/domain/local-review"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { projectDiffHunkLines } from "@diffdash/domain/diff-hunk-lines"
import { LocalReviewSnapshotManifest } from "@diffdash/domain/review-context"
import {
  makeReviewDiffIdentity,
  makeReviewSnapshotId,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import {
  CurrentReviewAnchor,
  LineReviewAnchor,
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
} from "@diffdash/domain/review-thread"
import { makeDemoReviewTurn } from "./review-thread-fixtures"
import {
  buildWalkthroughHunkDigest,
  StoredWalkthrough,
  Walkthrough,
  WalkthroughChapter,
  type WalkthroughHunkId,
  walkthroughHostedReviewScope,
  walkthroughLocalDiffScope,
  WalkthroughStop,
  WalkthroughSupportItem,
} from "@diffdash/domain/walkthrough"
import { type MaterializedDemoRevision, type MaterializedDemoScenario } from "./demo-scenario"

const rootPath = RepositoryCheckoutPath.make("/Users/demo/emberline-dispatch")
const workingTreeBaseSha = "4b7c939f526dce56d26f4383a832e23186c24684"
const branchMergeBaseSha = "73e9bd92aeb7c0f4bf61e152ead72dc60ef128bf"
const branchTargetTipSha = "dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const branchTargetOnlyPath = "docs/dev-release-notes.md"

/** Complete deterministic state for one local demo review target. */
export interface DemoLocalReviewFixture {
  readonly id: "working-tree" | "branch"
  readonly target: LocalReviewTarget
  readonly manifest: LocalReviewSnapshotManifest
  readonly diff: LocalReviewDiff
  readonly parsedDiff: ParsedDiff
  readonly walkthrough: StoredWalkthrough
  readonly threads: readonly ReviewThreadDetails[]
  readonly initiallyViewedFileKeys: readonly string[]
  readonly comparisonTargetSha: string | null
  readonly excludedTargetOnlyPaths: readonly string[]
}

/** Builds isolated working-tree and merge-base branch fixtures from coherent authored revisions. */
export const createDemoLocalReviewFixtures = (
  scenario: MaterializedDemoScenario,
): readonly [DemoLocalReviewFixture, DemoLocalReviewFixture] => {
  const workingRevision = scenario.revisions[0]
  if (workingRevision === undefined) throw new Error("Local demo requires an initial revision")
  const workingTarget = workingTreeReviewTarget(rootPath)
  const branchTarget = LocalReviewTarget.make({
    kind: "local",
    rootPath,
    comparison: BranchComparison.make({
      branchName: RepositoryComparisonRef.make("dev"),
      baseRef: RepositoryComparisonRef.make("refs/remotes/origin/dev"),
      baseSha: ReviewRevision.make(branchMergeBaseSha),
    }),
  })
  const working = makeFixture({
    id: "working-tree",
    scenario,
    revision: workingRevision,
    target: workingTarget,
    reviewKey: ReviewKey.make("local:demo-emberline-dispatch:working-tree"),
    baseSha: workingTreeBaseSha,
    title: "Local changes",
    comparisonTargetSha: null,
    excludedTargetOnlyPaths: [],
    threadPath: "packages/db/src/replay-claims.ts",
    viewedPath: "docs/runbooks/webhook-replays.md",
  })
  const branch = makeFixture({
    id: "branch",
    scenario,
    revision: scenario.currentRevision,
    target: branchTarget,
    reviewKey: ReviewKey.make("local:demo-emberline-dispatch:branch:dev"),
    baseSha: branchMergeBaseSha,
    title: "Changes vs dev",
    comparisonTargetSha: branchTargetTipSha,
    excludedTargetOnlyPaths: [branchTargetOnlyPath],
    threadPath: "services/webhooks/src/replay/claim-delivery.ts",
    viewedPath: "services/webhooks/src/replay/__tests__/claim-delivery.test.ts",
  })
  return [working, branch]
}

const makeFixture = (input: {
  readonly id: DemoLocalReviewFixture["id"]
  readonly scenario: MaterializedDemoScenario
  readonly revision: MaterializedDemoRevision
  readonly target: LocalReviewTarget
  readonly reviewKey: ReviewKey
  readonly baseSha: string
  readonly title: string
  readonly comparisonTargetSha: string | null
  readonly excludedTargetOnlyPaths: readonly string[]
  readonly threadPath: string
  readonly viewedPath: string
}): DemoLocalReviewFixture => {
  const diffIdentity = makeReviewDiffIdentity(input.revision.diff.diff)
  const baseRevision = ReviewRevision.make(input.baseSha)
  const headRevision = ReviewRevision.make(diffIdentity)
  const detail = LocalReviewDetail.make({
    rootPath,
    repoName: input.scenario.manifest.repository.name,
    branchName: RepositoryComparisonRef.make(input.scenario.manifest.pullRequest.headRefName),
    comparison: input.target.comparison,
    baseSha: baseRevision,
    headSha: headRevision,
    diffHash: diffIdentity,
    title: input.title,
    files: input.revision.parsedDiff.files.map((file) =>
      ChangedFile.make({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status,
      }),
    ),
    fetchedAt: input.revision.diff.fetchedAt,
  })
  const diff = LocalReviewDiff.make({
    rootPath,
    comparison: input.target.comparison,
    baseSha: baseRevision,
    headSha: headRevision,
    diffHash: diffIdentity,
    diff: input.revision.diff.diff,
    fetchedAt: input.revision.diff.fetchedAt,
  })
  const manifest = LocalReviewSnapshotManifest.make({
    projectId: input.scenario.repository.id,
    snapshotId: makeReviewSnapshotId({
      reviewKey: input.reviewKey,
      baseRevision,
      headRevision,
      diffIdentity,
    }),
    reviewKey: input.reviewKey,
    baseRevision,
    headRevision,
    fileCount: input.revision.parsedDiff.files.length,
    detail,
  })
  const walkthrough = localWalkthrough(input.revision, manifest)
  const thread = localThread(
    input.id,
    input.scenario.repository.id,
    manifest,
    input.revision.parsedDiff,
    input.threadPath,
  )
  const viewedFile = input.revision.parsedDiff.files.find((file) => file.path === input.viewedPath)
  if (viewedFile === undefined) throw new Error(`Local fixture cannot view ${input.viewedPath}`)
  return {
    id: input.id,
    target: input.target,
    manifest,
    diff,
    parsedDiff: input.revision.parsedDiff,
    walkthrough,
    threads: [thread],
    initiallyViewedFileKeys: [viewedFile.reviewKey],
    comparisonTargetSha: input.comparisonTargetSha,
    excludedTargetOnlyPaths: input.excludedTargetOnlyPaths,
  }
}

const localWalkthrough = (
  revision: MaterializedDemoRevision,
  manifest: LocalReviewSnapshotManifest,
) => {
  const hostedScope = walkthroughHostedReviewScope(revision.detail.summary.locator)
  const localScope = walkthroughLocalDiffScope(manifest.headRevision)
  const hostedDigest = buildWalkthroughHunkDigest(revision.parsedDiff.files, hostedScope)
  const localDigest = buildWalkthroughHunkDigest(revision.parsedDiff.files, localScope)
  const localIdByHostedId = new Map(
    hostedDigest.flatMap((hosted, index) => {
      const local = localDigest[index]
      return local === undefined ? [] : [[hosted.id, local.id] as const]
    }),
  )
  const mapIds = (ids: readonly WalkthroughHunkId[]) =>
    ids.map((id) => {
      const localId = localIdByHostedId.get(id)
      if (localId === undefined) throw new Error(`Local walkthrough cannot map hunk ${id}`)
      return localId
    })
  const source = revision.walkthrough.walkthrough
  return StoredWalkthrough.make({
    repoId: ReviewProjectId.make(`local:${revision.detail.summary.locator.repository.name}`),
    prNumber: null,
    reviewKey: manifest.reviewKey,
    baseSha: manifest.baseRevision,
    headSha: manifest.headRevision,
    promptVersion: revision.walkthrough.promptVersion,
    walkthrough: Walkthrough.make({
      ...source,
      chapters: source.chapters.map((chapter) =>
        WalkthroughChapter.make({
          ...chapter,
          stops: chapter.stops.map((stop) =>
            WalkthroughStop.make({ ...stop, hunkIds: mapIds(stop.hunkIds) }),
          ),
        }),
      ),
      support: source.support.map((item) =>
        WalkthroughSupportItem.make({ ...item, hunkIds: mapIds(item.hunkIds) }),
      ),
    }),
    createdAt: revision.walkthrough.createdAt,
  })
}

const localThread = (
  fixtureId: DemoLocalReviewFixture["id"],
  repoId: ReviewProjectId,
  manifest: LocalReviewSnapshotManifest,
  parsedDiff: ParsedDiff,
  path: string,
) => {
  const file = parsedDiff.files.find((candidate) => candidate.path === path)
  const hunk = file?.hunks[0]
  const line =
    hunk === undefined
      ? undefined
      : projectDiffHunkLines(hunk).find(
          (candidate) => candidate.kind === "addition" && candidate.newLineNumber !== null,
        )
  if (
    file === undefined ||
    hunk === undefined ||
    line?.newLineNumber === null ||
    line === undefined
  ) {
    throw new Error(`Local ${fixtureId} fixture cannot anchor ${path}`)
  }
  const anchor = LineReviewAnchor.make({
    fileId: file.fileId,
    filePath: file.path,
    oldPath: file.oldPath,
    hunkId: hunk.id,
    hunkFingerprint: hunk.fingerprint,
    hunkHeader: hunk.header,
    side: "new",
    lineNumber: line.newLineNumber,
    lineContent: line.content,
  })
  const threadId = ReviewThreadId.make(`thread-local-${fixtureId}`)
  const createdAt = fixtureId === "working-tree" ? "2026-07-10T08:40:00Z" : "2026-07-10T08:41:00Z"
  const thread = ReviewThread.make({
    id: threadId,
    repoId,
    reviewKey: manifest.reviewKey,
    prNumber: null,
    baseRevision: manifest.baseRevision,
    headRevision: manifest.headRevision,
    currentBaseRevision: manifest.baseRevision,
    currentHeadRevision: manifest.headRevision,
    originalAnchor: anchor,
    currentAnchor: CurrentReviewAnchor.cases.Active.make({ anchor }),
    createdAt,
    updatedAt: createdAt,
  })
  return ReviewThreadDetails.make({
    thread,
    conversation: [
      makeDemoReviewTurn(thread, {
        id: `message-local-${fixtureId}`,
        sequence: 0,
        bodyMarkdown:
          fixtureId === "working-tree"
            ? "Should this unpushed claim change include a recovery test?"
            : "Does the merge-base comparison contain only branch-authored changes?",
        author: "user",
        status: "complete",
        agentRunId: null,
        createdAt,
        updatedAt: createdAt,
      }),
    ],
  })
}
