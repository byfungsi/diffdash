import type { HostedReviewLocator } from "@diffdash/domain/git-provider"
import type { LocalReviewTarget } from "@diffdash/domain/local-review"
import type {
  HostedReviewSnapshot,
  LocalReviewSnapshot,
  ReviewSnapshot,
} from "@diffdash/domain/review-context"
import {
  ReviewSnapshotId,
  type ReviewSnapshotId as ReviewSnapshotIdType,
} from "@diffdash/domain/review-identity"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { ReviewContextService, type ReviewContextError } from "./review-context"

/** Default explicit memory and expiry bounds for immutable main-process snapshots. */
const DEFAULT_REVIEW_SNAPSHOT_CACHE_CONFIG = {
  capacity: 8,
  ttlMs: 5 * 60 * 1_000,
  tombstoneCapacity: 32,
} as const

/** Configurable memory and expiry bounds for the main-process snapshot cache. */
interface ReviewSnapshotCacheConfig {
  readonly capacity: number
  readonly ttlMs: number
  readonly tombstoneCapacity?: number
}

/** Observable cache state used by deterministic service tests and diagnostics. */
interface ReviewSnapshotCacheStats {
  readonly size: number
  readonly snapshotIds: readonly ReviewSnapshotIdType[]
}

/** A renderer revision key no longer resolves to an immutable cached snapshot. */
export class ReviewSnapshotUnavailableError extends Schema.TaggedError<ReviewSnapshotUnavailableError>()(
  "ReviewSnapshotUnavailableError",
  {
    snapshotId: ReviewSnapshotId,
    reason: Schema.Literal("expired", "evicted", "mismatched"),
  },
) {}

interface SnapshotEntry {
  readonly snapshot: ReviewSnapshot
  readonly expiresAt: number
  lastAccessedAt: number
}

interface SnapshotTombstone {
  readonly reason: "expired" | "evicted"
  readonly recordedAt: number
}

/** Owns coherent snapshot acquisition and a bounded immutable revision-keyed LRU/TTL cache. */
export class ReviewSnapshotService extends Context.Tag("@diffdash/ReviewSnapshotService")<
  ReviewSnapshotService,
  {
    readonly acquireHosted: (
      review: HostedReviewLocator,
    ) => Effect.Effect<HostedReviewSnapshot, ReviewContextError>
    readonly acquireLocal: (
      target: LocalReviewTarget,
    ) => Effect.Effect<LocalReviewSnapshot, ReviewContextError>
    readonly get: (
      snapshotId: ReviewSnapshotIdType,
    ) => Effect.Effect<ReviewSnapshot, ReviewSnapshotUnavailableError>
    readonly stats: Effect.Effect<ReviewSnapshotCacheStats>
  }
>() {
  /** Builds the cache layer with explicit, validated capacity and TTL bounds. */
  static readonly layer = (
    config: ReviewSnapshotCacheConfig = DEFAULT_REVIEW_SNAPSHOT_CACHE_CONFIG,
  ) =>
    Layer.effect(
      ReviewSnapshotService,
      Effect.gen(function* () {
        validateConfig(config)
        const contexts = yield* ReviewContextService
        const entries = new Map<ReviewSnapshotIdType, SnapshotEntry>()
        const tombstones = new Map<ReviewSnapshotIdType, SnapshotTombstone>()
        const tombstoneCapacity = config.tombstoneCapacity ?? config.capacity * 4
        let accessSequence = 0

        const recordTombstone = (
          snapshotId: ReviewSnapshotIdType,
          reason: SnapshotTombstone["reason"],
          now: number,
        ) => {
          tombstones.delete(snapshotId)
          tombstones.set(snapshotId, { reason, recordedAt: now })
          while (tombstones.size > tombstoneCapacity) {
            const oldest = tombstones.keys().next().value
            if (oldest === undefined) break
            tombstones.delete(oldest)
          }
        }

        const removeExpired = (now: number) => {
          for (const [snapshotId, entry] of entries) {
            if (entry.expiresAt > now) continue
            entries.delete(snapshotId)
            recordTombstone(snapshotId, "expired", now)
          }
        }

        const put = <Snapshot extends ReviewSnapshot>(
          snapshot: Snapshot,
          now: number,
        ): Snapshot => {
          removeExpired(now)
          deepFreeze(snapshot)
          const current = entries.get(snapshot.snapshotId)
          if (current !== undefined) {
            accessSequence += 1
            current.lastAccessedAt = accessSequence
            return snapshot
          }

          accessSequence += 1
          entries.set(snapshot.snapshotId, {
            snapshot,
            expiresAt: now + config.ttlMs,
            lastAccessedAt: accessSequence,
          })
          tombstones.delete(snapshot.snapshotId)

          while (entries.size > config.capacity) {
            let leastRecent: { readonly id: ReviewSnapshotIdType; readonly at: number } | null =
              null
            for (const [id, entry] of entries) {
              if (id === snapshot.snapshotId) continue
              if (leastRecent === null || entry.lastAccessedAt < leastRecent.at) {
                leastRecent = { id, at: entry.lastAccessedAt }
              }
            }
            if (leastRecent === null) break
            entries.delete(leastRecent.id)
            recordTombstone(leastRecent.id, "evicted", now)
          }
          return snapshot
        }

        const acquireHosted = Effect.fn("ReviewSnapshotService.acquireHosted")(function* (
          review: HostedReviewLocator,
        ) {
          const snapshot = yield* contexts.getHostedReviewSnapshot(review)
          const now = yield* Clock.currentTimeMillis
          return put(snapshot, now)
        })

        const acquireLocal = Effect.fn("ReviewSnapshotService.acquireLocal")(function* (
          target: LocalReviewTarget,
        ) {
          const snapshot = yield* contexts.getLocalReviewSnapshot(target)
          const now = yield* Clock.currentTimeMillis
          return put(snapshot, now)
        })

        const get = Effect.fn("ReviewSnapshotService.get")(function* (
          snapshotId: ReviewSnapshotIdType,
        ) {
          const now = yield* Clock.currentTimeMillis
          removeExpired(now)
          const entry = entries.get(snapshotId)
          if (entry === undefined) {
            return yield* ReviewSnapshotUnavailableError.make({
              snapshotId,
              reason: tombstones.get(snapshotId)?.reason ?? "mismatched",
            })
          }
          accessSequence += 1
          entry.lastAccessedAt = accessSequence
          return entry.snapshot
        })

        return ReviewSnapshotService.of({
          acquireHosted,
          acquireLocal,
          get,
          stats: Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              removeExpired(now)
              return { size: entries.size, snapshotIds: [...entries.keys()] }
            }),
          ),
        })
      }),
    )
}

const validateConfig = (config: ReviewSnapshotCacheConfig) => {
  const tombstoneCapacity = config.tombstoneCapacity ?? config.capacity * 4
  if (
    !Number.isSafeInteger(config.capacity) ||
    config.capacity <= 0 ||
    !Number.isSafeInteger(config.ttlMs) ||
    config.ttlMs <= 0 ||
    !Number.isSafeInteger(tombstoneCapacity) ||
    tombstoneCapacity <= 0
  ) {
    throw new Error("Review snapshot cache bounds must be positive safe integers")
  }
}

const deepFreeze = (value: unknown): void => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return
  for (const child of Object.values(value)) deepFreeze(child)
  Object.freeze(value)
}
