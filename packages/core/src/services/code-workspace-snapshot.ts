import type { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc"
import { CodeWorkspaceLeaseId } from "@diffdash/domain/code-workspace"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { GitCommitSha } from "@diffdash/domain/repository-comparison"
import { ReviewDescriptor } from "@diffdash/domain/review-context"
import { ReviewProjectId, ReviewRevision, ReviewSnapshotId } from "@diffdash/domain/review-identity"
import { GitService } from "@diffdash/local-git/local-git"
import {
  SnapshotBlockStore,
  SnapshotStorageSource,
  StoredSnapshotId,
} from "@diffdash/persistence/snapshot-block-store"
import { ResourceCatalog, ResourceLeaseId } from "@diffdash/persistence/resource-catalog"
import { Clock, Context, Data, Effect, Layer, Schema } from "effect"

const LEASE_LIFETIME_MS = 60 * 60 * 1_000

/** Checkout strategy retained by a saved local-review snapshot. */
export type CodeWorkspaceSnapshotCheckout = Data.TaggedEnum<{
  ExactGit: { readonly revision: GitCommitSha }
  ManagedSpool: { readonly baseRevision: GitCommitSha }
}>

/** Constructors for saved local-review checkout strategies. */
export const CodeWorkspaceSnapshotCheckout = Data.taggedEnum<CodeWorkspaceSnapshotCheckout>()

/** Validated workspace facts resolved from a saved local-review snapshot. */
export interface CodeWorkspaceSnapshot {
  readonly checkout: CodeWorkspaceSnapshotCheckout
  readonly headRevision: ReviewRevision
  readonly rootPath: RepositoryCheckoutPath
}

/** Expected failure while resolving or materializing a saved local-review workspace. */
export class CodeWorkspaceSnapshotError extends Schema.TaggedError<CodeWorkspaceSnapshotError>()(
  "CodeWorkspaceSnapshotError",
  {
    operation: Schema.Literals(["resolve", "materialize"]),
    message: Schema.String,
  },
) {}

interface CodeWorkspaceSnapshotOwner {
  readonly applicationInstanceId: ApplicationInstanceId
  readonly processEpoch: CoreProcessEpoch
}

/** Core authority for resolving and materializing saved local-review workspaces. */
export class CodeWorkspaceSnapshotSource extends Context.Service<
  CodeWorkspaceSnapshotSource,
  {
    readonly resolve: (
      snapshotId: ReviewSnapshotId,
      projectId: ReviewProjectId,
    ) => Effect.Effect<CodeWorkspaceSnapshot, CodeWorkspaceSnapshotError>
    readonly materialize: (input: {
      readonly snapshotId: ReviewSnapshotId
      readonly leaseId: CodeWorkspaceLeaseId
      readonly localPath: RepositoryCheckoutPath
      readonly owner: CodeWorkspaceSnapshotOwner
    }) => Effect.Effect<void, CodeWorkspaceSnapshotError>
  }
>()("@diffdash/core/CodeWorkspaceSnapshotSource") {
  /** Production snapshot persistence and Git materialization implementation. */
  static readonly layer = Layer.effect(
    CodeWorkspaceSnapshotSource,
    Effect.gen(function* () {
      const git = yield* GitService
      const resources = yield* ResourceCatalog
      const snapshots = yield* SnapshotBlockStore

      const load = (snapshotId: ReviewSnapshotId) =>
        snapshots.getSnapshotHeader(StoredSnapshotId.make(snapshotId)).pipe(
          Effect.mapError(() =>
            CodeWorkspaceSnapshotError.make({
              operation: "resolve",
              message: "The saved local review snapshot is unavailable.",
            }),
          ),
        )

      return CodeWorkspaceSnapshotSource.of({
        resolve: Effect.fn("CodeWorkspaceSnapshotSource.resolve")(
          function* (snapshotId, projectId) {
            const snapshot = yield* load(snapshotId)
            if (snapshot.projectId !== projectId) {
              return yield* CodeWorkspaceSnapshotError.make({
                operation: "resolve",
                message: "The saved local review snapshot does not belong to this project.",
              })
            }
            const localReview = yield* ReviewDescriptor.match(snapshot.descriptor, {
              hosted: () =>
                CodeWorkspaceSnapshotError.make({
                  operation: "resolve",
                  message: "The requested snapshot is not a local review.",
                }),
              local: (descriptor) => Effect.succeed(descriptor),
              repositoryComparison: () =>
                CodeWorkspaceSnapshotError.make({
                  operation: "resolve",
                  message: "The requested snapshot is not a local review.",
                }),
            })
            const checkout = yield* SnapshotStorageSource.match(snapshot.source, {
              exactGit: ({ headObject }) =>
                decodeGitCommitSha(headObject).pipe(
                  Effect.map((revision) => CodeWorkspaceSnapshotCheckout.ExactGit({ revision })),
                ),
              managedSpool: () =>
                decodeGitCommitSha(snapshot.baseRevision).pipe(
                  Effect.map((baseRevision) =>
                    CodeWorkspaceSnapshotCheckout.ManagedSpool({ baseRevision }),
                  ),
                ),
            })
            return {
              checkout,
              headRevision: ReviewRevision.make(snapshot.headRevision),
              rootPath: localReview.target.rootPath,
            }
          },
        ),
        materialize: Effect.fn("CodeWorkspaceSnapshotSource.materialize")((input) =>
          Effect.gen(function* () {
            const snapshot = yield* load(input.snapshotId)
            const spoolResourceId = yield* SnapshotStorageSource.match(snapshot.source, {
              exactGit: () =>
                CodeWorkspaceSnapshotError.make({
                  operation: "materialize",
                  message: "The saved local review does not contain a managed patch.",
                }),
              managedSpool: ({ resourceId }) => Effect.succeed(resourceId),
            })
            const resourceLeaseId = ResourceLeaseId.make(`code-workspace:${input.leaseId}`)
            yield* Effect.scoped(
              Effect.acquireRelease(
                Clock.currentTimeMillis.pipe(
                  Effect.flatMap((nowMs) =>
                    resources.acquireLease({
                      id: resourceLeaseId,
                      resourceId: spoolResourceId,
                      ownerKind: "codeWorkspace",
                      ownerId: input.leaseId,
                      applicationInstanceId: input.owner.applicationInstanceId,
                      processEpoch: input.owner.processEpoch,
                      acquiredAtMs: nowMs,
                      renewedAtMs: nowMs,
                      expiresAtMs: nowMs + LEASE_LIFETIME_MS,
                      purpose: "materialize local review snapshot",
                    }),
                  ),
                ),
                () =>
                  resources
                    .releaseLease({
                      id: resourceLeaseId,
                      applicationInstanceId: input.owner.applicationInstanceId,
                      processEpoch: input.owner.processEpoch,
                    })
                    .pipe(Effect.ignore),
              ).pipe(
                Effect.andThen(snapshots.readSnapshotSpool(spoolResourceId)),
                Effect.flatMap((patch) =>
                  patch.length === 0
                    ? Effect.void
                    : git.applyWorkspacePatch(input.localPath, patch),
                ),
              ),
            )
          }).pipe(
            Effect.mapError(() =>
              CodeWorkspaceSnapshotError.make({
                operation: "materialize",
                message: "DiffDash could not apply the saved local review patch.",
              }),
            ),
          ),
        ),
      })
    }),
  )
}

const decodeGitCommitSha = (value: string) =>
  Schema.decodeUnknownEffect(GitCommitSha)(value).pipe(
    Effect.mapError(() =>
      CodeWorkspaceSnapshotError.make({
        operation: "resolve",
        message: "The saved local review does not identify a valid Git revision.",
      }),
    ),
  )
