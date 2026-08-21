import type { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc"
import {
  CodeWorkspaceError,
  CodeWorkspaceFileContent,
  CodeWorkspaceFileReadRejected,
  CodeWorkspaceLease,
  CodeWorkspaceLeaseId,
  CodeWorkspaceSearchResult,
  type CodeWorkspaceFileReadRejectionReason,
  type CodeWorkspaceTarget,
} from "@diffdash/domain/code-workspace"
import { AgentRunId } from "@diffdash/domain/agent-run-id"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { GitCommitSha } from "@diffdash/domain/repository-comparison"
import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { HostedReviewWorkspacePool } from "@diffdash/local-git/hosted-review-workspace-pool"
import { LocalCheckoutFiles } from "@diffdash/local-git/local-checkout-files"
import { ManagedWorkspaceFiles } from "@diffdash/local-git/managed-workspace-files"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { Clock, Context, Deferred, Effect, Layer, Match, Ref, Schedule, Scope } from "effect"

import { AgentWorkspaceResources } from "../agent-workspace-resources"
import { CoreAbsolutePath } from "../core-configuration"
import { ResourceCollection } from "../resource-collection"
import { GitProvider } from "./git-provider"
import { GitService } from "@diffdash/local-git/local-git"

const LEASE_LIFETIME_MS = 60 * 60 * 1_000
const LEASE_RENEWAL_MS = 20 * 60 * 1_000

interface CodeWorkspaceOwner {
  readonly applicationInstanceId: ApplicationInstanceId
  readonly processEpoch: CoreProcessEpoch
}

interface CodeWorkspaceSession extends CodeWorkspaceOwner {
  readonly localPath: RepositoryCheckoutPath
  readonly revision: GitCommitSha
  readonly expiresAtMs: number
  readonly release: Deferred.Deferred<void>
  readonly index: Effect.Effect<readonly RepositoryRelativePath[], CodeWorkspaceError>
}

interface CodeWorkspaceSessionDecision {
  readonly session: CodeWorkspaceSession | null
  readonly failure: "leaseExpired" | "leaseNotFound" | null
  readonly release: Deferred.Deferred<void> | null
}

/** Core-owned lifecycle and filesystem authority for renderer Code workspaces. */
export class CodeWorkspaceService extends Context.Service<
  CodeWorkspaceService,
  {
    readonly open: (
      target: CodeWorkspaceTarget,
      owner: CodeWorkspaceOwner,
    ) => Effect.Effect<CodeWorkspaceLease, CodeWorkspaceError>
    readonly heartbeat: (
      leaseId: CodeWorkspaceLeaseId,
      owner: CodeWorkspaceOwner,
    ) => Effect.Effect<CodeWorkspaceLease, CodeWorkspaceError>
    readonly release: (
      leaseId: CodeWorkspaceLeaseId,
      owner: CodeWorkspaceOwner,
    ) => Effect.Effect<void, CodeWorkspaceError>
    readonly listDirectory: (
      leaseId: CodeWorkspaceLeaseId,
      owner: CodeWorkspaceOwner,
      path: RepositoryRelativePath | null,
      offset: number,
      limit: number,
    ) => Effect.Effect<
      import("@diffdash/domain/code-workspace").CodeWorkspaceDirectoryPage,
      CodeWorkspaceError
    >
    readonly search: (
      leaseId: CodeWorkspaceLeaseId,
      owner: CodeWorkspaceOwner,
      query: string,
      offset: number,
      limit: number,
    ) => Effect.Effect<CodeWorkspaceSearchResult, CodeWorkspaceError>
    readonly readFile: (
      leaseId: CodeWorkspaceLeaseId,
      owner: CodeWorkspaceOwner,
      path: RepositoryRelativePath,
    ) => Effect.Effect<
      import("@diffdash/domain/code-workspace").CodeWorkspaceFileReadResult,
      CodeWorkspaceError
    >
  }
>()("@diffdash/core/CodeWorkspaceService") {
  /** Production managed-worktree implementation. */
  static readonly layer = Layer.effect(
    CodeWorkspaceService,
    Effect.gen(function* () {
      const repositories = yield* RepositoryStore
      const providers = yield* GitProvider
      const git = yield* GitService
      const pool = yield* HostedReviewWorkspacePool
      const resources = yield* AgentWorkspaceResources
      const files = yield* ManagedWorkspaceFiles
      const checkoutFiles = yield* LocalCheckoutFiles
      const collection = yield* ResourceCollection
      const sessions = yield* Ref.make(new Map<CodeWorkspaceLeaseId, CodeWorkspaceSession>())
      const scope = yield* Scope.Scope

      const expireLeases = Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis
        const expired = yield* Ref.modify(sessions, (current) => {
          const found = [...current].filter(([, session]) => session.expiresAtMs <= nowMs)
          const updated = new Map(current)
          for (const [leaseId] of found) updated.delete(leaseId)
          return [found, updated]
        })
        if (expired.length === 0) return
        yield* Effect.forEach(
          expired,
          ([, session]) => Deferred.succeed(session.release, undefined),
          {
            discard: true,
          },
        )
      })
      yield* Effect.forkIn(expireLeases.pipe(Effect.repeat(Schedule.spaced("1 minute"))), scope)

      const getSession = Effect.fn("CodeWorkspaceService.getSession")(function* (
        leaseId: CodeWorkspaceLeaseId,
        owner: CodeWorkspaceOwner,
      ) {
        const nowMs = yield* Clock.currentTimeMillis
        const result = yield* Ref.modify(
          sessions,
          (
            current,
          ): readonly [
            CodeWorkspaceSessionDecision,
            Map<CodeWorkspaceLeaseId, CodeWorkspaceSession>,
          ] => {
            const session = current.get(leaseId)
            if (session === undefined || !sameOwner(session, owner)) {
              return [{ session: null, failure: "leaseNotFound", release: null }, current]
            }
            if (session.expiresAtMs > nowMs) {
              return [{ session, failure: null, release: null }, current]
            }
            return [
              { session: null, failure: "leaseExpired", release: session.release },
              withoutSession(current, leaseId),
            ]
          },
        )
        if (result.failure !== null) {
          if (result.release !== null) yield* Deferred.succeed(result.release, undefined)
          return yield* workspaceFailure("lookup", result.failure)
        }
        if (result.session === null) return yield* workspaceFailure("lookup", "leaseNotFound")
        return result.session
      })

      const open = Effect.fn("CodeWorkspaceService.open")(function* (
        target: CodeWorkspaceTarget,
        owner: CodeWorkspaceOwner,
      ) {
        const repository = yield* repositories
          .getById(target.projectId)
          .pipe(
            Effect.mapError((cause) =>
              workspaceError(
                "open",
                cause.operation === "getById.notFound"
                  ? "repositoryNotFound"
                  : "repositoryUnavailable",
              ),
            ),
          )
        const resolved = yield* resolveRevisionInput(target, repository, providers, git)
        const leaseId = CodeWorkspaceLeaseId.make(crypto.randomUUID())
        const ready = yield* Deferred.make<
          { readonly localPath: RepositoryCheckoutPath; readonly revision: GitCommitSha },
          CodeWorkspaceError
        >()
        const release = yield* Deferred.make<void>()
        const worker = pool
          .useRevision(resolved, (localPath) =>
            resources.protect(
              {
                localPath,
                agentRunId: AgentRunId.make(leaseId),
                applicationInstanceId: owner.applicationInstanceId,
                processEpoch: owner.processEpoch,
                leaseLifetimeMs: LEASE_LIFETIME_MS,
                leaseRenewalMs: LEASE_RENEWAL_MS,
              },
              Deferred.succeed(ready, { localPath, revision: resolved.revision }).pipe(
                Effect.andThen(Deferred.await(release)),
              ),
            ),
          )
          .pipe(
            Effect.mapError(() => workspaceError("open", "workspaceUnavailable")),
            Effect.tapError((error) => Deferred.fail(ready, error)),
            Effect.ensuring(
              Ref.update(sessions, (current) => withoutSession(current, leaseId)).pipe(
                Effect.andThen(
                  Clock.currentTimeMillis.pipe(
                    Effect.flatMap((nowMs) => collection.collectPolicy(nowMs, nowMs + 60_000)),
                    Effect.ignore,
                  ),
                ),
              ),
            ),
          )
        yield* Effect.forkIn(worker, scope)
        return yield* Effect.gen(function* () {
          const prepared = yield* Deferred.await(ready)
          const index = yield* Effect.cached(
            files
              .indexFiles(prepared.localPath)
              .pipe(Effect.mapError(() => workspaceError("search", "workspaceUnavailable"))),
          )
          const nowMs = yield* Clock.currentTimeMillis
          const session: CodeWorkspaceSession = {
            ...owner,
            localPath: prepared.localPath,
            revision: prepared.revision,
            expiresAtMs: nowMs + LEASE_LIFETIME_MS,
            release,
            index,
          }
          yield* Ref.update(sessions, (current) => new Map(current).set(leaseId, session))
          return CodeWorkspaceLease.make({
            id: leaseId,
            revision: session.revision,
            expiresAtMs: session.expiresAtMs,
          })
        }).pipe(
          Effect.onInterrupt(() =>
            Ref.update(sessions, (current) => withoutSession(current, leaseId)).pipe(
              Effect.andThen(Deferred.succeed(release, undefined)),
            ),
          ),
        )
      })

      return CodeWorkspaceService.of({
        open,
        heartbeat: Effect.fn("CodeWorkspaceService.heartbeat")(function* (leaseId, owner) {
          const nowMs = yield* Clock.currentTimeMillis
          const result = yield* Ref.modify(
            sessions,
            (
              current,
            ): readonly [
              CodeWorkspaceSessionDecision,
              Map<CodeWorkspaceLeaseId, CodeWorkspaceSession>,
            ] => {
              const session = current.get(leaseId)
              if (session === undefined || !sameOwner(session, owner)) {
                return [{ session: null, failure: "leaseNotFound", release: null }, current]
              }
              if (session.expiresAtMs <= nowMs) {
                return [
                  { session: null, failure: "leaseExpired", release: session.release },
                  withoutSession(current, leaseId),
                ]
              }
              const renewed = { ...session, expiresAtMs: nowMs + LEASE_LIFETIME_MS }
              return [
                { session: renewed, failure: null, release: null },
                new Map(current).set(leaseId, renewed),
              ]
            },
          )
          if (result.failure !== null) {
            if (result.release !== null) yield* Deferred.succeed(result.release, undefined)
            return yield* workspaceFailure("heartbeat", result.failure)
          }
          const renewed = result.session
          if (renewed === null) return yield* workspaceFailure("heartbeat", "leaseNotFound")
          return CodeWorkspaceLease.make({
            id: leaseId,
            revision: renewed.revision,
            expiresAtMs: renewed.expiresAtMs,
          })
        }),
        release: Effect.fn("CodeWorkspaceService.release")(function* (leaseId, owner) {
          const session = yield* Ref.modify(sessions, (current) => {
            const found = current.get(leaseId)
            if (found === undefined || !sameOwner(found, owner)) return [null, current]
            return [found, withoutSession(current, leaseId)]
          })
          if (session === null) return
          yield* Deferred.succeed(session.release, undefined)
        }),
        listDirectory: Effect.fn("CodeWorkspaceService.listDirectory")(
          function* (leaseId, owner, path, offset, limit) {
            const session = yield* getSession(leaseId, owner)
            return yield* files.listDirectory(session.localPath, path, offset, limit)
          },
        ),
        search: Effect.fn("CodeWorkspaceService.search")(
          function* (leaseId, owner, query, offset, limit) {
            const session = yield* getSession(leaseId, owner)
            const normalized = query.trim().toLocaleLowerCase()
            const matches = (yield* session.index).filter(
              (path) => normalized.length === 0 || path.toLocaleLowerCase().includes(normalized),
            )
            const end = Math.min(offset + limit, matches.length)
            return CodeWorkspaceSearchResult.make({
              paths: matches.slice(offset, end),
              nextOffset: end < matches.length ? end : null,
            })
          },
        ),
        readFile: Effect.fn("CodeWorkspaceService.readFile")(function* (leaseId, owner, path) {
          const session = yield* getSession(leaseId, owner)
          const result = yield* checkoutFiles.read(session.localPath, path)
          return Match.valueTags(result, {
            content: (content) => CodeWorkspaceFileContent.make(content),
            rejected: (rejected) => {
              const reason: CodeWorkspaceFileReadRejectionReason =
                rejected.reason === "checkoutUnavailable" ||
                rejected.reason === "repositoryNotFound" ||
                rejected.reason === "repositoryUnavailable"
                  ? "ioFailure"
                  : rejected.reason
              return CodeWorkspaceFileReadRejected.make({ path, reason })
            },
          })
        }),
      })
    }),
  )
}

const resolveRevisionInput = Effect.fn("CodeWorkspaceService.resolveRevisionInput")(function* (
  target: CodeWorkspaceTarget,
  repository: import("@diffdash/domain/repository").Repo,
  providers: Context.Service.Shape<typeof GitProvider>,
  git: Context.Service.Shape<typeof GitService>,
) {
  const locator = repository.hostedLocator
  return yield* Match.valueTags(target, {
    hostedReview: (hostedTarget) =>
      providers.hostedReviewCheckoutSpec(hostedTarget.review, hostedTarget.revision).pipe(
        Effect.map((checkout) => ({
          repository: checkout.repository,
          sourcePath: repository.localPath,
          remoteUrl: checkout.remoteUrl,
          revision: GitCommitSha.make(checkout.revision),
          fetchRef: checkout.fetchRef,
          bootstrapBareRepository: (destination: RepositoryCheckoutPath) =>
            providers
              .bootstrapBareRepository(checkout.repository, CoreAbsolutePath.make(destination))
              .pipe(Effect.mapError(() => new Error("Repository bootstrap failed"))),
        })),
        Effect.mapError(() => workspaceError("open", "revisionUnavailable")),
      ),
    projectRevision: (revisionTarget) =>
      Effect.succeed(
        projectRevisionInput(
          repository,
          locator,
          providers,
          GitCommitSha.make(revisionTarget.revision),
        ),
      ),
    projectHead: () =>
      repository.localPath === null
        ? workspaceFailure("open", "repositoryUnavailable")
        : git.resolveLastCommit(repository.localPath).pipe(
            Effect.flatMap((resolved) =>
              Match.valueTags(resolved.comparison, {
                lastCommit: ({ headSha }) => Effect.succeed(GitCommitSha.make(headSha)),
                workingTree: () => workspaceFailure("open", "revisionUnavailable"),
                branch: () => workspaceFailure("open", "revisionUnavailable"),
                revision: () => workspaceFailure("open", "revisionUnavailable"),
                revisionRange: () => workspaceFailure("open", "revisionUnavailable"),
              }),
            ),
            Effect.map((revision) =>
              projectRevisionInput(repository, locator, providers, revision),
            ),
            Effect.mapError(() => workspaceError("open", "revisionUnavailable")),
          ),
  })
})

const projectRevisionInput = (
  repository: import("@diffdash/domain/repository").Repo,
  locator: import("@diffdash/domain/git-provider").HostedRepositoryLocator | null,
  providers: Context.Service.Shape<typeof GitProvider>,
  revision: GitCommitSha,
) => ({
  repository: locator,
  cacheKey: repository.id,
  sourcePath: repository.localPath,
  remoteUrl: repository.remoteUrl,
  revision,
  bootstrapBareRepository: (destination: RepositoryCheckoutPath) =>
    locator === null
      ? Effect.fail(new Error(`Local repository cache cannot bootstrap ${destination}`))
      : providers
          .bootstrapBareRepository(locator, CoreAbsolutePath.make(destination))
          .pipe(Effect.mapError(() => new Error("Repository bootstrap failed"))),
})

const sameOwner = (session: CodeWorkspaceSession, owner: CodeWorkspaceOwner): boolean =>
  session.applicationInstanceId === owner.applicationInstanceId &&
  session.processEpoch === owner.processEpoch

const withoutSession = (
  sessions: ReadonlyMap<CodeWorkspaceLeaseId, CodeWorkspaceSession>,
  leaseId: CodeWorkspaceLeaseId,
): Map<CodeWorkspaceLeaseId, CodeWorkspaceSession> => {
  const updated = new Map(sessions)
  updated.delete(leaseId)
  return updated
}

const workspaceFailure = (operation: string, reason: CodeWorkspaceError["reason"]) =>
  Effect.fail(workspaceError(operation, reason))

const workspaceError = (operation: string, reason: CodeWorkspaceError["reason"]) =>
  CodeWorkspaceError.make({
    operation,
    reason,
    message: "The managed Code workspace is unavailable.",
  })
