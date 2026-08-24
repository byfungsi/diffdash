import type { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc"
import {
  CodeWorkspaceError,
  CodeWorkspaceChangesResult,
  CodeWorkspaceFileChange,
  CodeWorkspaceFileContent,
  type CodeWorkspaceFileReadResult,
  CodeWorkspaceFileReadRejected,
  CodeWorkspaceLease,
  CodeWorkspaceLeaseId,
  CodeWorkspaceLineChangesResult,
  CodeWorkspaceSearchResult,
  type CodeWorkspaceFileReadRejectionReason,
  CodeWorkspaceTarget,
  type LocalReviewSnapshotCodeWorkspaceTarget,
} from "@diffdash/domain/code-workspace"
import { LocalCheckoutFileReadResult } from "@diffdash/domain/local-checkout-file"
import { LocalReviewComparison } from "@diffdash/domain/local-review"
import { AgentRunId } from "@diffdash/domain/agent-run-id"
import {
  type LanguageAdapterId,
  LanguageOperationError,
  type LanguagePosition,
  type RepositoryLanguageLocationResult,
} from "@diffdash/domain/language"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { GitCommitSha } from "@diffdash/domain/repository-comparison"
import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewRevision } from "@diffdash/domain/review-identity"
import {
  HostedReviewWorkspacePool,
  type HostedRepositoryRevisionInput,
} from "@diffdash/local-git/hosted-review-workspace-pool"
import { LocalCheckoutFiles } from "@diffdash/local-git/local-checkout-files"
import { ManagedWorkspaceFiles } from "@diffdash/local-git/managed-workspace-files"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import type { LanguageAdapterSession } from "@diffdash/language-provider"
import { LanguageAdapterRegistry } from "@diffdash/language-provider/registry"
import {
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  HashMap,
  HashSet,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
  Scope,
} from "effect"

import { AgentWorkspaceResources } from "../agent-workspace-resources"
import { CoreAbsolutePath } from "../core-configuration"
import { ResourceCollection } from "../resource-collection"
import { GitProvider } from "./git-provider"
import { GitService } from "@diffdash/local-git/local-git"
import {
  CodeWorkspaceSnapshotCheckout,
  CodeWorkspaceSnapshotSource,
} from "./code-workspace-snapshot"

const LEASE_LIFETIME_MS = 60 * 60 * 1_000
const LEASE_RENEWAL_MS = 20 * 60 * 1_000

type CodeWorkspaceLanguageLocationOperation = Data.TaggedEnum<{
  Definitions: {}
  References: {}
}>

const CodeWorkspaceLanguageLocationOperation =
  Data.taggedEnum<CodeWorkspaceLanguageLocationOperation>()

type LanguageSessionRetryPolicy = Data.TaggedEnum<{
  Restart: {}
  Propagate: {}
}>

const LanguageSessionRetryPolicy = Data.taggedEnum<LanguageSessionRetryPolicy>()

const restartableLanguageFailureReasons = HashSet.fromIterable<LanguageOperationError["reason"]>([
  "serverUnavailable",
  "serverFailed",
  "timeout",
  "malformedResponse",
])

interface CodeWorkspaceOwner {
  readonly applicationInstanceId: ApplicationInstanceId
  readonly processEpoch: CoreProcessEpoch
}

interface CodeWorkspaceSession extends CodeWorkspaceOwner {
  readonly localPath: RepositoryCheckoutPath
  readonly workingTreePath: Option.Option<RepositoryCheckoutPath>
  readonly revision: ReviewRevision
  readonly gitRevision: Option.Option<GitCommitSha>
  readonly expiresAtMs: number
  readonly release: Deferred.Deferred<void>
  readonly index: Effect.Effect<readonly RepositoryRelativePath[], CodeWorkspaceError>
  readonly languageSessions: HashMap.HashMap<LanguageAdapterId, CodeWorkspaceLanguageSession>
}

class CodeWorkspaceLanguageSession {
  constructor(
    readonly get: Effect.Effect<CodeWorkspaceLanguageGeneration, LanguageOperationError>,
    readonly invalidate: Effect.Effect<void>,
  ) {}
}

class CodeWorkspaceLanguageGeneration {
  constructor(
    readonly session: LanguageAdapterSession,
    readonly close: Effect.Effect<void>,
  ) {}
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
    readonly changes: (
      leaseId: CodeWorkspaceLeaseId,
      owner: CodeWorkspaceOwner,
    ) => Effect.Effect<CodeWorkspaceChangesResult, CodeWorkspaceError>
    readonly lineChanges: (
      leaseId: CodeWorkspaceLeaseId,
      owner: CodeWorkspaceOwner,
      path: RepositoryRelativePath,
    ) => Effect.Effect<CodeWorkspaceLineChangesResult, CodeWorkspaceError>
    readonly definitions: (
      leaseId: CodeWorkspaceLeaseId,
      owner: CodeWorkspaceOwner,
      path: RepositoryRelativePath,
      position: LanguagePosition,
    ) => Effect.Effect<
      RepositoryLanguageLocationResult,
      CodeWorkspaceError | LanguageOperationError
    >
    readonly references: (
      leaseId: CodeWorkspaceLeaseId,
      owner: CodeWorkspaceOwner,
      path: RepositoryRelativePath,
      position: LanguagePosition,
    ) => Effect.Effect<
      RepositoryLanguageLocationResult,
      CodeWorkspaceError | LanguageOperationError
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
      const languageAdapters = yield* LanguageAdapterRegistry
      const snapshotSource = yield* CodeWorkspaceSnapshotSource
      const sessions = yield* Ref.make(HashMap.empty<CodeWorkspaceLeaseId, CodeWorkspaceSession>())
      const scope = yield* Scope.Scope

      const expireLeases = Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis
        const expired = yield* Ref.modify(sessions, (current) => {
          const found = [...current].filter(([, session]) => session.expiresAtMs <= nowMs)
          return [
            found,
            HashMap.removeMany(
              current,
              found.map(([leaseId]) => leaseId),
            ),
          ]
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
        const lookup = yield* Ref.modify(
          sessions,
          (
            current,
          ): readonly [
            Effect.Effect<CodeWorkspaceSession, CodeWorkspaceError>,
            HashMap.HashMap<CodeWorkspaceLeaseId, CodeWorkspaceSession>,
          ] => {
            return Option.match(
              Option.filter(HashMap.get(current, leaseId), (candidate) =>
                sameOwner(candidate, owner),
              ),
              {
                onNone: () => [workspaceFailure("lookup", "leaseNotFound"), current],
                onSome: (session) =>
                  session.expiresAtMs > nowMs
                    ? [Effect.succeed(session), current]
                    : [
                        Deferred.succeed(session.release, undefined).pipe(
                          Effect.andThen(workspaceFailure("lookup", "leaseExpired")),
                        ),
                        HashMap.remove(current, leaseId),
                      ],
              },
            )
          },
        )
        return yield* lookup
      })

      const languageLocations = Effect.fn("CodeWorkspaceService.languageLocations")(function* (
        operation: CodeWorkspaceLanguageLocationOperation,
        leaseId: CodeWorkspaceLeaseId,
        owner: CodeWorkspaceOwner,
        path: RepositoryRelativePath,
        position: LanguagePosition,
      ) {
        const session = yield* getSession(leaseId, owner)
        const fileName = path.slice(path.lastIndexOf("/") + 1)
        const dot = fileName.lastIndexOf(".")
        const extension = dot <= 0 ? "" : fileName.slice(dot).toLocaleLowerCase()
        const operationName = CodeWorkspaceLanguageLocationOperation.$match(operation, {
          Definitions: () => "definitions" as const,
          References: () => "references" as const,
        })
        const registration = yield* Option.match(languageAdapters.resolveExtension(extension), {
          onNone: () =>
            languageFailure(
              operationName,
              "unsupportedLanguage",
              `No bundled language adapter supports ${extension || "this file"}.`,
            ),
          onSome: Effect.succeed,
        })
        const supported = CodeWorkspaceLanguageLocationOperation.$match(operation, {
          Definitions: () => registration.descriptor.capabilities.definitions,
          References: () => registration.descriptor.capabilities.references,
        })
        if (!supported) {
          return yield* languageFailure(
            operationName,
            "unsupportedCapability",
            `${registration.descriptor.displayName} does not support ${operationName}.`,
          )
        }
        const source = yield* checkoutFiles.read(session.localPath, path)
        yield* LocalCheckoutFileReadResult.match<Effect.Effect<void, LanguageOperationError>>(
          source,
          {
            content: () => Effect.void,
            rejected: () =>
              languageFailure(
                operationName,
                "serverUnavailable",
                "The source file is unavailable for language analysis.",
              ),
          },
        )
        const adapter = yield* Option.match(
          HashMap.get(session.languageSessions, registration.descriptor.id),
          {
            onNone: () =>
              languageFailure(
                operationName,
                "serverUnavailable",
                "The language adapter session is unavailable.",
              ),
            onSome: Effect.succeed,
          },
        )
        const generationRequest = adapter.get
        const generation = yield* generationRequest.pipe(
          Effect.catch((error) =>
            LanguageSessionRetryPolicy.$match(languageSessionRetryPolicy(error), {
              Restart: () => adapter.invalidate.pipe(Effect.andThen(adapter.get)),
              Propagate: () => Effect.fail(error),
            }),
          ),
        )
        const request = CodeWorkspaceLanguageLocationOperation.$match(operation, {
          Definitions: () => generation.session.definitions(path, position),
          References: () => generation.session.references(path, position),
        })
        const handledRequest = request.pipe(
          Effect.catch((error) =>
            LanguageSessionRetryPolicy.$match(languageSessionRetryPolicy(error), {
              Propagate: () => Effect.fail(error),
              Restart: () =>
                generation.close.pipe(
                  Effect.andThen(adapter.invalidate),
                  Effect.andThen(adapter.get),
                  Effect.flatMap((next) =>
                    CodeWorkspaceLanguageLocationOperation.$match(operation, {
                      Definitions: () => next.session.definitions(path, position),
                      References: () => next.session.references(path, position),
                    }),
                  ),
                ),
            }),
          ),
        )
        return yield* handledRequest
      })

      const open = Effect.fn("CodeWorkspaceService.open")(function* (
        target: CodeWorkspaceTarget,
        owner: CodeWorkspaceOwner,
      ) {
        const repositoryRequest = repositories.getById(target.projectId)
        const repository = yield* repositoryRequest.pipe(
          Effect.mapError((cause) =>
            workspaceError(
              "open",
              cause.operation === "getById.notFound"
                ? "repositoryNotFound"
                : "repositoryUnavailable",
            ),
          ),
        )
        const leaseId = CodeWorkspaceLeaseId.make(crypto.randomUUID())
        const ready = yield* Deferred.make<
          {
            readonly localPath: RepositoryCheckoutPath
            readonly revision: ReviewRevision
            readonly gitRevision: Option.Option<GitCommitSha>
            readonly workingTreePath: Option.Option<RepositoryCheckoutPath>
            readonly languageSessions: HashMap.HashMap<
              LanguageAdapterId,
              CodeWorkspaceLanguageSession
            >
          },
          CodeWorkspaceError
        >()
        const release = yield* Deferred.make<void>()
        const runSession = (
          localPath: RepositoryCheckoutPath,
          revision: ReviewRevision,
          gitRevision: Option.Option<GitCommitSha>,
          workingTreePath: Option.Option<RepositoryCheckoutPath>,
        ) =>
          Effect.scoped(
            Effect.gen(function* () {
              const leaseScope = yield* Scope.Scope
              const registrations = yield* languageAdapters.list
              const languageSessionEntries = yield* Effect.forEach(registrations, (registration) =>
                Effect.gen(function* () {
                  const openSession = Effect.gen(function* () {
                    const generationScope = yield* Scope.make()
                    const close = Scope.close(generationScope, Exit.void)
                    yield* Scope.addFinalizer(leaseScope, close)
                    const languageSession = yield* registration.probe.pipe(
                      Effect.andThen(registration.openSession(localPath)),
                      Effect.provideService(Scope.Scope, generationScope),
                      Effect.catch((error) => close.pipe(Effect.andThen(Effect.fail(error)))),
                    )
                    return new CodeWorkspaceLanguageGeneration(languageSession, close)
                  })
                  const [get, invalidate] = yield* Effect.cachedInvalidateWithTTL(
                    openSession,
                    Duration.infinity,
                  )
                  return [
                    registration.descriptor.id,
                    new CodeWorkspaceLanguageSession(get, invalidate),
                  ] as const
                }),
              )
              yield* Deferred.succeed(ready, {
                localPath,
                revision,
                gitRevision,
                workingTreePath,
                languageSessions: HashMap.fromIterable(languageSessionEntries),
              })
              yield* Deferred.await(release)
            }),
          )
        const managedSession = (
          input: HostedRepositoryRevisionInput,
          revision: ReviewRevision,
          gitRevision: Option.Option<GitCommitSha>,
          prepare: (localPath: RepositoryCheckoutPath) => Effect.Effect<void, CodeWorkspaceError>,
        ) =>
          pool.useRevision(input, (localPath) =>
            prepare(localPath).pipe(
              Effect.andThen(
                resources.protect(
                  {
                    localPath,
                    agentRunId: AgentRunId.make(leaseId),
                    applicationInstanceId: owner.applicationInstanceId,
                    processEpoch: owner.processEpoch,
                    leaseLifetimeMs: LEASE_LIFETIME_MS,
                    leaseRenewalMs: LEASE_RENEWAL_MS,
                  },
                  runSession(localPath, revision, gitRevision, Option.none()),
                ),
              ),
            ),
          )
        const openLocalReviewSnapshot = Effect.fn("CodeWorkspaceService.openLocalReviewSnapshot")(
          function* (snapshotTarget: LocalReviewSnapshotCodeWorkspaceTarget) {
            const snapshot = yield* snapshotSource
              .resolve(snapshotTarget.snapshotId, snapshotTarget.projectId)
              .pipe(
                Effect.mapError((error) =>
                  workspaceError("open.localReviewSnapshot", "snapshotUnavailable", error.message),
                ),
              )
            return yield* CodeWorkspaceSnapshotCheckout.$match(snapshot.checkout, {
              ExactGit: ({ revision }) =>
                managedSession(
                  projectRevisionInput(
                    repository,
                    Option.fromNullishOr(repository.hostedLocator),
                    providers,
                    revision,
                    Option.some(snapshot.rootPath),
                  ),
                  snapshot.headRevision,
                  Option.some(revision),
                  () => Effect.void,
                ),
              ManagedSpool: ({ baseRevision }) =>
                managedSession(
                  projectRevisionInput(
                    repository,
                    Option.fromNullishOr(repository.hostedLocator),
                    providers,
                    baseRevision,
                    Option.some(snapshot.rootPath),
                  ),
                  snapshot.headRevision,
                  Option.none(),
                  (localPath) =>
                    snapshotSource
                      .materialize({
                        snapshotId: snapshotTarget.snapshotId,
                        leaseId,
                        localPath,
                        owner,
                      })
                      .pipe(
                        Effect.mapError((error) =>
                          workspaceError(
                            "open.localReviewSnapshot",
                            "snapshotUnavailable",
                            error.message,
                          ),
                        ),
                      ),
                ),
            })
          },
        )
        const worker = CodeWorkspaceTarget.match(target, {
          projectHead: (projectHeadTarget) => {
            return Option.match(Option.fromNullishOr(repository.localPath), {
              onNone: () => workspaceFailure("open", "repositoryUnavailable"),
              onSome: (localPath) =>
                resolveRevisionInput(projectHeadTarget, repository, providers, git).pipe(
                  Effect.flatMap(({ revision }) =>
                    runSession(
                      localPath,
                      ReviewRevision.make(revision),
                      Option.some(revision),
                      Option.some(localPath),
                    ),
                  ),
                ),
            })
          },
          projectRevision: (projectRevisionTarget) =>
            resolveRevisionInput(projectRevisionTarget, repository, providers, git).pipe(
              Effect.flatMap((resolved) =>
                managedSession(
                  resolved,
                  ReviewRevision.make(resolved.revision),
                  Option.some(resolved.revision),
                  () => Effect.void,
                ),
              ),
            ),
          hostedReview: (hostedReviewTarget) =>
            resolveRevisionInput(hostedReviewTarget, repository, providers, git).pipe(
              Effect.flatMap((resolved) =>
                managedSession(
                  resolved,
                  ReviewRevision.make(resolved.revision),
                  Option.some(resolved.revision),
                  () => Effect.void,
                ),
              ),
            ),
          localReviewSnapshot: openLocalReviewSnapshot,
        })
        const handledWorker = worker.pipe(
          Effect.catch((error) => {
            if (Schema.is(CodeWorkspaceError)(error)) return Effect.fail(error)
            return workspaceFailure("open", "workspaceUnavailable")
          }),
          Effect.tapError((error) => Deferred.fail(ready, error)),
          Effect.ensuring(
            Ref.update(sessions, HashMap.remove(leaseId)).pipe(
              Effect.andThen(
                CodeWorkspaceTarget.match(target, {
                  projectHead: () => Effect.void,
                  localReviewSnapshot: () =>
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap((nowMs) => collection.collectPolicy(nowMs, nowMs + 60_000)),
                      Effect.ignore,
                    ),
                  projectRevision: () =>
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap((nowMs) => collection.collectPolicy(nowMs, nowMs + 60_000)),
                      Effect.ignore,
                    ),
                  hostedReview: () =>
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap((nowMs) => collection.collectPolicy(nowMs, nowMs + 60_000)),
                      Effect.ignore,
                    ),
                }),
              ),
            ),
          ),
        )
        yield* Effect.forkIn(handledWorker, scope)
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
            workingTreePath: prepared.workingTreePath,
            revision: prepared.revision,
            gitRevision: prepared.gitRevision,
            expiresAtMs: nowMs + LEASE_LIFETIME_MS,
            release,
            index,
            languageSessions: prepared.languageSessions,
          }
          yield* Ref.update(sessions, HashMap.set(leaseId, session))
          return CodeWorkspaceLease.make({
            id: leaseId,
            revision: session.revision,
            gitRevision: session.gitRevision,
            expiresAtMs: session.expiresAtMs,
          })
        }).pipe(
          Effect.onInterrupt(() =>
            Ref.update(sessions, HashMap.remove(leaseId)).pipe(
              Effect.andThen(Deferred.succeed(release, undefined)),
            ),
          ),
        )
      })

      return CodeWorkspaceService.of({
        open,
        heartbeat: Effect.fn("CodeWorkspaceService.heartbeat")(function* (leaseId, owner) {
          const nowMs = yield* Clock.currentTimeMillis
          const heartbeat = yield* Ref.modify(
            sessions,
            (
              current,
            ): readonly [
              Effect.Effect<CodeWorkspaceSession, CodeWorkspaceError>,
              HashMap.HashMap<CodeWorkspaceLeaseId, CodeWorkspaceSession>,
            ] => {
              return Option.match(
                Option.filter(HashMap.get(current, leaseId), (session) =>
                  sameOwner(session, owner),
                ),
                {
                  onNone: () => [workspaceFailure("heartbeat", "leaseNotFound"), current],
                  onSome: (session) => {
                    if (session.expiresAtMs <= nowMs) {
                      return [
                        Deferred.succeed(session.release, undefined).pipe(
                          Effect.andThen(workspaceFailure("heartbeat", "leaseExpired")),
                        ),
                        HashMap.remove(current, leaseId),
                      ]
                    }
                    const renewed: CodeWorkspaceSession = {
                      ...session,
                      expiresAtMs: nowMs + LEASE_LIFETIME_MS,
                    }
                    return [Effect.succeed(renewed), HashMap.set(current, leaseId, renewed)]
                  },
                },
              )
            },
          )
          const renewed = yield* heartbeat
          return CodeWorkspaceLease.make({
            id: leaseId,
            revision: renewed.revision,
            gitRevision: renewed.gitRevision,
            expiresAtMs: renewed.expiresAtMs,
          })
        }),
        release: Effect.fn("CodeWorkspaceService.release")(function* (leaseId, owner) {
          const session = yield* Ref.modify(sessions, (current) => {
            return Option.match(
              Option.filter(HashMap.get(current, leaseId), (candidate) =>
                sameOwner(candidate, owner),
              ),
              {
                onNone: () => [Option.none<CodeWorkspaceSession>(), current] as const,
                onSome: (found) => [Option.some(found), HashMap.remove(current, leaseId)] as const,
              },
            )
          })
          yield* Option.match(session, {
            onNone: () => Effect.void,
            onSome: (found) => Deferred.succeed(found.release, undefined),
          })
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
          return LocalCheckoutFileReadResult.match<CodeWorkspaceFileReadResult>(result, {
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
        changes: Effect.fn("CodeWorkspaceService.changes")(function* (leaseId, owner) {
          const session = yield* getSession(leaseId, owner)
          return yield* Option.match(session.workingTreePath, {
            onNone: () =>
              Effect.succeed(CodeWorkspaceChangesResult.make({ changes: [], truncated: false })),
            onSome: (workingTreePath) =>
              git.workingTreeChanges(workingTreePath).pipe(
                Effect.mapError(() => workspaceError("changes", "workspaceUnavailable")),
                Effect.map((changes) =>
                  CodeWorkspaceChangesResult.make({
                    changes: changes
                      .slice(0, 5_000)
                      .map(({ path, status }) => CodeWorkspaceFileChange.make({ path, status })),
                    truncated: changes.length > 5_000,
                  }),
                ),
              ),
          })
        }),
        lineChanges: Effect.fn("CodeWorkspaceService.lineChanges")(
          function* (leaseId, owner, path) {
            const session = yield* getSession(leaseId, owner)
            return yield* Option.match(session.workingTreePath, {
              onNone: () =>
                Effect.succeed(
                  CodeWorkspaceLineChangesResult.make({ changes: [], truncated: false }),
                ),
              onSome: (workingTreePath) =>
                git.workingTreeFileLineChanges(workingTreePath, path).pipe(
                  Effect.mapError(() => workspaceError("lineChanges", "workspaceUnavailable")),
                  Effect.map((changes) =>
                    CodeWorkspaceLineChangesResult.make({
                      changes: changes.slice(0, 5_000),
                      truncated: changes.length > 5_000,
                    }),
                  ),
                ),
            })
          },
        ),
        definitions: Effect.fn("CodeWorkspaceService.definitions")(
          (leaseId, owner, path, position) =>
            languageLocations(
              CodeWorkspaceLanguageLocationOperation.Definitions(),
              leaseId,
              owner,
              path,
              position,
            ),
        ),
        references: Effect.fn("CodeWorkspaceService.references")((leaseId, owner, path, position) =>
          languageLocations(
            CodeWorkspaceLanguageLocationOperation.References(),
            leaseId,
            owner,
            path,
            position,
          ),
        ),
      })
    }),
  )
}

const languageFailure = (
  operation: string,
  reason: LanguageOperationError["reason"],
  message: string,
): Effect.Effect<never, LanguageOperationError> =>
  Effect.fail(LanguageOperationError.make({ operation, reason, message }))

const languageSessionRetryPolicy = (error: LanguageOperationError) => {
  if (HashSet.has(restartableLanguageFailureReasons, error.reason)) {
    return LanguageSessionRetryPolicy.Restart()
  }
  return LanguageSessionRetryPolicy.Propagate()
}

const resolveRevisionInput = Effect.fn("CodeWorkspaceService.resolveRevisionInput")(function* (
  target: CodeWorkspaceTarget,
  repository: import("@diffdash/domain/repository").Repo,
  providers: Context.Service.Shape<typeof GitProvider>,
  git: Context.Service.Shape<typeof GitService>,
) {
  const locator = Option.fromNullishOr(repository.hostedLocator)
  return yield* CodeWorkspaceTarget.match(target, {
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
      Option.match(Option.fromNullishOr(repository.localPath), {
        onNone: () => workspaceFailure("open", "repositoryUnavailable"),
        onSome: (localPath) =>
          git.resolveLastCommit(localPath).pipe(
            Effect.flatMap((resolved) =>
              LocalReviewComparison.match(resolved.comparison, {
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
      }),
    localReviewSnapshot: () => workspaceFailure("open", "revisionUnavailable"),
  })
})

const projectRevisionInput = (
  repository: import("@diffdash/domain/repository").Repo,
  locator: Option.Option<import("@diffdash/domain/git-provider").HostedRepositoryLocator>,
  providers: Context.Service.Shape<typeof GitProvider>,
  revision: GitCommitSha,
  sourcePath: Option.Option<RepositoryCheckoutPath> = Option.fromNullishOr(repository.localPath),
) => ({
  repository: Option.getOrNull(locator),
  cacheKey: repository.id,
  sourcePath: Option.getOrNull(sourcePath),
  remoteUrl: repository.remoteUrl,
  revision,
  bootstrapBareRepository: (destination: RepositoryCheckoutPath) =>
    Option.match(locator, {
      onNone: () =>
        Effect.fail(new Error(`Local repository cache cannot bootstrap ${destination}`)),
      onSome: (hostedLocator) =>
        providers
          .bootstrapBareRepository(hostedLocator, CoreAbsolutePath.make(destination))
          .pipe(Effect.mapError(() => new Error("Repository bootstrap failed"))),
    }),
})

const sameOwner = (session: CodeWorkspaceSession, owner: CodeWorkspaceOwner): boolean =>
  session.applicationInstanceId === owner.applicationInstanceId &&
  session.processEpoch === owner.processEpoch

const workspaceFailure = (
  operation: string,
  reason: CodeWorkspaceError["reason"],
  message = "The managed Code workspace is unavailable.",
) => Effect.fail(workspaceError(operation, reason, message))

const workspaceError = (
  operation: string,
  reason: CodeWorkspaceError["reason"],
  message = "The managed Code workspace is unavailable.",
) =>
  CodeWorkspaceError.make({
    operation,
    reason,
    message,
  })
