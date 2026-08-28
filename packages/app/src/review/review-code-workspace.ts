import {
  CodeWorkspaceFileReadResult,
  CodeWorkspaceLease,
  CodeWorkspaceTarget,
  HostedReviewCodeWorkspaceTarget,
  LocalReviewSnapshotCodeWorkspaceTarget,
  ProjectRevisionCodeWorkspaceTarget,
} from "@diffdash/domain/code-workspace"
import { type DiffFileStatus, type ParsedDiffFile } from "@diffdash/domain/diff"
import type { LanguagePosition, RepositoryLanguageLocationResult } from "@diffdash/domain/language"
import { GitCommitSha } from "@diffdash/domain/repository-comparison"
import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { Effect, Option, Schema, Scope, SynchronizedRef } from "effect"

import type { CodeWorkspace } from "@/platform/code-workspace"
import type { RendererApiError } from "@/platform/renderer-api-error"
import type { SourceSurfaceSide } from "@/source-surface/source-surface-runtime"
import { RendererReview, type RendererReview as RendererReviewType } from "./review-subject"
import type { FileDiffLoadedFiles } from "./pierre"

const REVIEW_WORKSPACE_HEARTBEAT_INTERVAL = "20 minutes"

/** Exact base and head workspace targets backing one review diff. */
export class ReviewCodeWorkspaceTargets extends Schema.Class<ReviewCodeWorkspaceTargets>(
  "ReviewCodeWorkspaceTargets",
)({
  base: Schema.Option(CodeWorkspaceTarget),
  head: CodeWorkspaceTarget,
}) {}

/** Recoverable review workspace lifecycle or source-resolution failure. */
export class ReviewCodeWorkspaceSessionError extends Schema.TaggedError<ReviewCodeWorkspaceSessionError>()(
  "ReviewCodeWorkspaceSessionError",
  {
    message: Schema.String,
    reason: Schema.Literals(["baseUnavailable", "closed", "sourceUnavailable"]),
  },
) {}

const ReviewCodeWorkspaceReview = RendererReview.pipe(Schema.toTaggedUnion("_tag"))

/** Derives side-specific Code workspace targets from an authoritative review snapshot. */
export const reviewCodeWorkspaceTargets = (
  review: RendererReviewType,
): ReviewCodeWorkspaceTargets =>
  ReviewCodeWorkspaceReview.match(review, {
    hosted: (hosted) =>
      new ReviewCodeWorkspaceTargets({
        base: Option.map(
          Schema.decodeUnknownOption(GitCommitSha)(hosted.baseRevision),
          (revision) =>
            ProjectRevisionCodeWorkspaceTarget.make({
              projectId: hosted.manifest.projectId,
              revision,
            }),
        ),
        head: HostedReviewCodeWorkspaceTarget.make({
          projectId: hosted.manifest.projectId,
          review: hosted.target,
          revision: hosted.headRevision,
        }),
      }),
    local: (local) =>
      new ReviewCodeWorkspaceTargets({
        base: Option.map(
          Schema.decodeUnknownOption(GitCommitSha)(local.manifest.detail.baseSha),
          (revision) =>
            ProjectRevisionCodeWorkspaceTarget.make({
              projectId: local.manifest.projectId,
              revision,
            }),
        ),
        head: LocalReviewSnapshotCodeWorkspaceTarget.make({
          projectId: local.manifest.projectId,
          snapshotId: local.manifest.snapshotId,
        }),
      }),
    repositoryComparison: (comparison) =>
      new ReviewCodeWorkspaceTargets({
        base: Option.some(
          ProjectRevisionCodeWorkspaceTarget.make({
            projectId: comparison.manifest.projectId,
            revision: comparison.target.mergeBaseSha,
          }),
        ),
        head: ProjectRevisionCodeWorkspaceTarget.make({
          projectId: comparison.manifest.projectId,
          revision: comparison.target.headSha,
        }),
      }),
  })

const ReviewCodeWorkspaceRevision = Schema.TaggedUnion({
  base: { target: CodeWorkspaceTarget },
  head: { target: CodeWorkspaceTarget },
})

type ReviewCodeWorkspaceRevision = typeof ReviewCodeWorkspaceRevision.Type

const ReviewCodeWorkspaceSessionState = Schema.TaggedUnion({
  open: {
    baseLease: Schema.Option(CodeWorkspaceLease),
    headLease: Schema.Option(CodeWorkspaceLease),
  },
  closed: {},
})

type ReviewCodeWorkspaceSessionState = typeof ReviewCodeWorkspaceSessionState.Type

const ReviewDiffExpansionSource = Schema.TaggedUnion({ empty: {}, workspace: {} })

class ReviewDiffExpansionPolicy extends Schema.Class<ReviewDiffExpansionPolicy>(
  "ReviewDiffExpansionPolicy",
)({
  newSource: ReviewDiffExpansionSource,
  oldSource: ReviewDiffExpansionSource,
}) {}

const emptyExpansionSource = ReviewDiffExpansionSource.cases.empty.make({})
const workspaceExpansionSource = ReviewDiffExpansionSource.cases.workspace.make({})
const reviewDiffExpansionPolicies: Record<DiffFileStatus, ReviewDiffExpansionPolicy> = {
  added: new ReviewDiffExpansionPolicy({
    newSource: workspaceExpansionSource,
    oldSource: emptyExpansionSource,
  }),
  binary: new ReviewDiffExpansionPolicy({
    newSource: workspaceExpansionSource,
    oldSource: workspaceExpansionSource,
  }),
  deleted: new ReviewDiffExpansionPolicy({
    newSource: emptyExpansionSource,
    oldSource: workspaceExpansionSource,
  }),
  modified: new ReviewDiffExpansionPolicy({
    newSource: workspaceExpansionSource,
    oldSource: workspaceExpansionSource,
  }),
  renamed: new ReviewDiffExpansionPolicy({
    newSource: workspaceExpansionSource,
    oldSource: workspaceExpansionSource,
  }),
}

/** Effect operations owned by one scoped review Code workspace session. */
export interface ReviewCodeWorkspaceSession {
  readonly definitions: (
    side: SourceSurfaceSide,
    path: RepositoryRelativePath,
    position: LanguagePosition,
  ) => Effect.Effect<
    RepositoryLanguageLocationResult,
    RendererApiError | ReviewCodeWorkspaceSessionError
  >
  readonly references: (
    side: SourceSurfaceSide,
    path: RepositoryRelativePath,
    position: LanguagePosition,
  ) => Effect.Effect<
    RepositoryLanguageLocationResult,
    RendererApiError | ReviewCodeWorkspaceSessionError
  >
  readonly readSource: (
    side: SourceSurfaceSide,
    path: RepositoryRelativePath,
  ) => Effect.Effect<Option.Option<string>, RendererApiError | ReviewCodeWorkspaceSessionError>
  readonly loadDiffFiles: (
    file: ParsedDiffFile,
  ) => Effect.Effect<FileDiffLoadedFiles, RendererApiError | ReviewCodeWorkspaceSessionError>
}

type ReviewCodeWorkspaceSessionFailure = RendererApiError | ReviewCodeWorkspaceSessionError
type ReviewCodeWorkspaceLeaseTransition = readonly [
  CodeWorkspaceLease,
  ReviewCodeWorkspaceSessionState,
]

/** Constructs one lazily leased review workspace session in the caller-owned scope. */
export const makeReviewCodeWorkspaceSession = Effect.fn("ReviewCodeWorkspaceSession.make")(
  function* (
    workspaces: CodeWorkspace["Service"],
    targets: ReviewCodeWorkspaceTargets,
  ): Effect.fn.Return<ReviewCodeWorkspaceSession, never, Scope.Scope> {
    const scope = yield* Scope.Scope
    const state = yield* SynchronizedRef.make<ReviewCodeWorkspaceSessionState>(
      ReviewCodeWorkspaceSessionState.cases.open.make({
        baseLease: Option.none(),
        headLease: Option.none(),
      }),
    )

    const releaseSession = SynchronizedRef.modifyEffect(state, (current) =>
      ReviewCodeWorkspaceSessionState.match(current, {
        closed: () => Effect.succeed([Schema.Boolean.make(false), current] as const),
        open: ({ baseLease, headLease }) => {
          const release = Effect.all(
            [
              Option.match(baseLease, {
                onNone: () => Effect.void,
                onSome: (lease) =>
                  workspaces.release(lease.id).pipe(Effect.catch(() => Effect.void)),
              }),
              Option.match(headLease, {
                onNone: () => Effect.void,
                onSome: (lease) =>
                  workspaces.release(lease.id).pipe(Effect.catch(() => Effect.void)),
              }),
            ],
            { discard: true },
          ).pipe(
            Effect.as([
              Schema.Boolean.make(true),
              ReviewCodeWorkspaceSessionState.cases.closed.make({}),
            ] as const),
          )
          return release
        },
      }),
    )
    yield* Effect.addFinalizer(() => releaseSession)

    const revisionForSide: Record<
      SourceSurfaceSide,
      () => Effect.Effect<ReviewCodeWorkspaceRevision, ReviewCodeWorkspaceSessionError>
    > = {
      additions: () =>
        Effect.succeed(ReviewCodeWorkspaceRevision.cases.head.make({ target: targets.head })),
      deletions: () =>
        Option.match(targets.base, {
          onNone: () =>
            Effect.fail(
              new ReviewCodeWorkspaceSessionError({
                message: "Review Code workspace base revision is unavailable.",
                reason: "baseUnavailable",
              }),
            ),
          onSome: (target) =>
            Effect.succeed(ReviewCodeWorkspaceRevision.cases.base.make({ target })),
        }),
    }

    const lease = Effect.fn("ReviewCodeWorkspaceSession.lease")(function* (
      side: SourceSurfaceSide,
    ) {
      const revision = yield* revisionForSide[side]()
      return yield* SynchronizedRef.modifyEffect(state, (current) =>
        ReviewCodeWorkspaceSessionState.match(current, {
          closed: (): Effect.Effect<
            ReviewCodeWorkspaceLeaseTransition,
            ReviewCodeWorkspaceSessionFailure
          > =>
            Effect.fail(
              new ReviewCodeWorkspaceSessionError({
                message: "Review Code workspace session is closed.",
                reason: "closed",
              }),
            ),
          open: ({
            baseLease,
            headLease,
          }): Effect.Effect<
            ReviewCodeWorkspaceLeaseTransition,
            ReviewCodeWorkspaceSessionFailure
          > => {
            const currentLease = ReviewCodeWorkspaceRevision.match(revision, {
              base: () => baseLease,
              head: () => headLease,
            })
            return Option.match(currentLease, {
              onSome: (openedLease) => Effect.succeed([openedLease, current] as const),
              onNone: () =>
                workspaces.open(revision.target).pipe(
                  Effect.tap((openedLease) => {
                    const heartbeat = Effect.sleep(REVIEW_WORKSPACE_HEARTBEAT_INTERVAL).pipe(
                      Effect.andThen(workspaces.heartbeat(openedLease.id)),
                      Effect.forever,
                    )
                    return heartbeat.pipe(
                      Effect.catch(() =>
                        SynchronizedRef.update(state, (latest) =>
                          ReviewCodeWorkspaceSessionState.match(latest, {
                            closed: () => latest,
                            open: (open) => {
                              const selectedLease = ReviewCodeWorkspaceRevision.match(revision, {
                                base: () => open.baseLease,
                                head: () => open.headLease,
                              })
                              return Option.match(
                                Option.filter(
                                  selectedLease,
                                  (activeLease) => activeLease.id === openedLease.id,
                                ),
                                {
                                  onNone: () => latest,
                                  onSome: () =>
                                    ReviewCodeWorkspaceRevision.match(revision, {
                                      base: () =>
                                        ReviewCodeWorkspaceSessionState.cases.open.make({
                                          ...open,
                                          baseLease: Option.none(),
                                        }),
                                      head: () =>
                                        ReviewCodeWorkspaceSessionState.cases.open.make({
                                          ...open,
                                          headLease: Option.none(),
                                        }),
                                    }),
                                },
                              )
                            },
                          }),
                        ).pipe(
                          Effect.andThen(workspaces.release(openedLease.id)),
                          Effect.catch(() => Effect.void),
                        ),
                      ),
                      Effect.forkIn(scope),
                    )
                  }),
                  Effect.map(
                    (openedLease) =>
                      [
                        openedLease,
                        ReviewCodeWorkspaceRevision.match(revision, {
                          base: () =>
                            ReviewCodeWorkspaceSessionState.cases.open.make({
                              baseLease: Option.some(openedLease),
                              headLease,
                            }),
                          head: () =>
                            ReviewCodeWorkspaceSessionState.cases.open.make({
                              baseLease,
                              headLease: Option.some(openedLease),
                            }),
                        }),
                      ] as const,
                  ),
                ),
            })
          },
        }),
      )
    })

    const definitions = Effect.fn("ReviewCodeWorkspaceSession.definitions")(function* (
      side: SourceSurfaceSide,
      path: RepositoryRelativePath,
      position: LanguagePosition,
    ) {
      const openedLease = yield* lease(side)
      return yield* workspaces.definitions(openedLease.id, path, position)
    })

    const references = Effect.fn("ReviewCodeWorkspaceSession.references")(function* (
      side: SourceSurfaceSide,
      path: RepositoryRelativePath,
      position: LanguagePosition,
    ) {
      const openedLease = yield* lease(side)
      return yield* workspaces.references(openedLease.id, path, position)
    })

    const readSource = Effect.fn("ReviewCodeWorkspaceSession.readSource")(function* (
      side: SourceSurfaceSide,
      path: RepositoryRelativePath,
    ) {
      const openedLease = yield* lease(side)
      const result = yield* workspaces.readFile(openedLease.id, path)
      return CodeWorkspaceFileReadResult.match(result, {
        content: ({ content }) => Option.some(content),
        rejected: () => Option.none(),
      })
    })

    const loadDiffFiles = Effect.fn("ReviewCodeWorkspaceSession.loadDiffFiles")(function* (
      file: ParsedDiffFile,
    ) {
      const oldPath = Option.getOrElse(Option.fromNullishOr(file.oldPath), () => file.path)
      const policy = reviewDiffExpansionPolicies[file.status]
      const oldSourceEffect = ReviewDiffExpansionSource.match(policy.oldSource, {
        empty: () => Effect.succeed(Option.some("")),
        workspace: () => readSource("deletions", oldPath),
      })
      const newSourceEffect = ReviewDiffExpansionSource.match(policy.newSource, {
        empty: () => Effect.succeed(Option.some("")),
        workspace: () => readSource("additions", file.path),
      })
      const { newSource, oldSource } = yield* Effect.all({
        newSource: newSourceEffect,
        oldSource: oldSourceEffect,
      })
      return yield* Effect.fromOption(
        Option.all([oldSource, newSource] as const),
        () =>
          new ReviewCodeWorkspaceSessionError({
            message: `Review diff expansion source is unavailable for ${file.reviewKey}.`,
            reason: "sourceUnavailable",
          }),
      ).pipe(
        Effect.map(([oldContents, newContents]) => ({
          oldFile: { name: oldPath, contents: oldContents },
          newFile: { name: file.path, contents: newContents },
        })),
      )
    })

    return { definitions, loadDiffFiles, readSource, references }
  },
)
