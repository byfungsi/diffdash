import { sep } from "node:path"

import { Effect } from "effect"

import { withFileLock } from "./hosted-review-workspace-file-lock"
import type { HostedReviewWorkspacePoolError } from "./hosted-review-workspace-pool-error"
import { makeManagedWorkspaceFilesystem } from "./hosted-review-workspace-paths"

const REPOSITORY_LOCK_TIMEOUT_MS = 30 * 60 * 1_000

/** Serializes a catalog mutation with worktree operations when the path belongs to a repository. */
export const withManagedWorkspaceRepositoryLock = <A, E, R>(
  rootPath: string,
  relativePath: string,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | HostedReviewWorkspacePoolError, R> =>
  Effect.gen(function* () {
    const filesystem = yield* makeManagedWorkspaceFilesystem(rootPath)
    const segments = relativePath.split(sep)
    if (segments.length < 3 || segments[0] !== "repositories") return yield* use
    const repositoryRoot = filesystem.path("repositories", segments[1] ?? "")
    return yield* withFileLock(
      filesystem,
      filesystem.child(repositoryRoot, "repository.lock"),
      () => use,
      REPOSITORY_LOCK_TIMEOUT_MS,
    )
  })
