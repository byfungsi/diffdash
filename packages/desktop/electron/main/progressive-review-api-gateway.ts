import type {
  CoreResolvedReviewTarget,
  CoreReviewInventoryPage,
  CoreReviewRange,
  CoreReviewSearchPublication,
  CoreReviewSessionIdentity,
  CoreReviewSessionState,
} from "@diffdash/core-rpc/review-session"
import {
  CoreReviewSessionId,
  CoreReviewSessionStateVersion,
} from "@diffdash/core-rpc/review-session"
import type { HostRequestContext } from "@diffdash/core-rpc/identity"
import { Match } from "effect"
import {
  ReviewSessionId,
  ReviewSessionProcessId,
  ReviewSessionStateVersion,
  type ProgressiveReviewApi,
  type ReviewSessionIdentity,
  type ReviewSessionSearchPublication,
  type ReviewSessionState,
} from "@diffdash/protocol/review-session"

/** Promise/async-iterable projection implemented by the authenticated native RPC client. */
export interface ProgressiveReviewNativeClient {
  readonly openSession: (
    request: HostRequestContext & {
      readonly projectId: Parameters<ProgressiveReviewApi["openSession"]>[0]["projectId"]
      readonly reviewKey: Parameters<ProgressiveReviewApi["openSession"]>[0]["reviewKey"]
      readonly snapshotId: Parameters<ProgressiveReviewApi["openSession"]>[0]["snapshotId"]
    },
  ) => Promise<CoreReviewSessionState>
  readonly currentSession: (
    request: HostRequestContext & { readonly identity: CoreReviewSessionIdentity },
  ) => Promise<CoreReviewSessionState>
  readonly closeSession: (
    request: HostRequestContext & { readonly identity: CoreReviewSessionIdentity },
  ) => Promise<CoreReviewSessionState>
  readonly inventory: (
    request: HostRequestContext & {
      readonly identity: CoreReviewSessionIdentity
      readonly offset: number
      readonly limit: number
    },
  ) => Promise<CoreReviewInventoryPage>
  readonly readRange: (request: NativeRangeRequest) => Promise<CoreReviewRange>
  readonly waitForRange: (request: NativeRangeRequest) => Promise<CoreReviewRange>
  readonly resolveTarget: (
    request: HostRequestContext & {
      readonly identity: CoreReviewSessionIdentity
      readonly fileId: Parameters<ProgressiveReviewApi["resolveTarget"]>[0]["fileId"]
      readonly hunkId: Parameters<ProgressiveReviewApi["resolveTarget"]>[0]["hunkId"]
      readonly line: number
    },
  ) => Promise<CoreResolvedReviewTarget>
  readonly search: (
    request: HostRequestContext & {
      readonly identity: CoreReviewSessionIdentity
      readonly query: string
      readonly anchorFileId: Parameters<ProgressiveReviewApi["search"]>[0]["anchorFileId"]
      readonly direction: Parameters<ProgressiveReviewApi["search"]>[0]["direction"]
      readonly cursor: Parameters<ProgressiveReviewApi["search"]>[0]["cursor"]
      readonly limit: number
    },
  ) => AsyncIterable<CoreReviewSearchPublication>
}

interface NativeRangeRequest extends HostRequestContext {
  readonly identity: CoreReviewSessionIdentity
  readonly fileId: Parameters<ProgressiveReviewApi["readRange"]>[0]["fileId"]
  readonly startLine: number
}

/** Maps the renderer protocol to native progressive RPC without exposing Core contracts. */
export const createProgressiveReviewApiGateway = (
  client: ProgressiveReviewNativeClient,
  requestContext: () => HostRequestContext,
): ProgressiveReviewApi => ({
  openSession: async (request) =>
    toBrowserState(await client.openSession({ ...requestContext(), ...request })),
  currentSession: async (request) => {
    const context = requestContext()
    return toBrowserState(
      await client.currentSession({
        ...context,
        identity: toNativeIdentity(request.identity, context),
      }),
    )
  },
  closeSession: async (request) => {
    const context = requestContext()
    return toBrowserState(
      await client.closeSession({
        ...context,
        identity: toNativeIdentity(request.identity, context),
      }),
    )
  },
  inventory: async (request) => {
    const context = requestContext()
    const page = await client.inventory({
      ...context,
      identity: toNativeIdentity(request.identity, context),
      offset: request.offset,
      limit: request.limit,
    })
    return {
      identity: toBrowserIdentity(page.identity),
      files: page.files,
      nextOffset: page.nextOffset,
    }
  },
  readRange: async (request) => {
    const context = requestContext()
    return toBrowserRange(await client.readRange(nativeRange(request, context)))
  },
  waitForRange: async (request) => {
    const context = requestContext()
    return toBrowserRange(await client.waitForRange(nativeRange(request, context)))
  },
  resolveTarget: async (request) => {
    const context = requestContext()
    const target = await client.resolveTarget({
      ...context,
      identity: toNativeIdentity(request.identity, context),
      fileId: request.fileId,
      hunkId: request.hunkId,
      line: request.line,
    })
    return {
      identity: toBrowserIdentity(target.identity),
      file: target.file,
      blockOrdinal: target.blockOrdinal,
      line: target.line,
    }
  },
  search: async (request, onPublication) => {
    const context = requestContext()
    const publications = client.search({
      ...context,
      identity: toNativeIdentity(request.identity, context),
      query: request.query,
      anchorFileId: request.anchorFileId,
      direction: request.direction,
      cursor: request.cursor,
      limit: request.limit,
    })
    for await (const publication of publications) {
      onPublication(toBrowserSearchPublication(publication))
    }
  },
})

const nativeRange = (
  request: Parameters<ProgressiveReviewApi["readRange"]>[0],
  context: HostRequestContext,
): NativeRangeRequest => ({
  ...context,
  identity: toNativeIdentity(request.identity, context),
  fileId: request.fileId,
  startLine: request.startLine,
})

const toNativeIdentity = (
  identity: ReviewSessionIdentity,
  context: HostRequestContext,
): CoreReviewSessionIdentity => {
  if (String(identity.processId) !== String(context.processEpoch)) {
    throw new Error("Progressive review identity belongs to another Core process epoch")
  }
  return {
    applicationInstanceId: context.applicationInstanceId,
    processEpoch: context.processEpoch,
    projectId: identity.projectId,
    reviewKey: identity.reviewKey,
    snapshotId: identity.snapshotId,
    sessionId: CoreReviewSessionId.make(identity.sessionId),
    stateVersion: CoreReviewSessionStateVersion.make(identity.stateVersion),
  }
}

const toBrowserIdentity = (identity: CoreReviewSessionIdentity): ReviewSessionIdentity => ({
  projectId: identity.projectId,
  reviewKey: identity.reviewKey,
  snapshotId: identity.snapshotId,
  processId: ReviewSessionProcessId.make(identity.processEpoch),
  sessionId: ReviewSessionId.make(identity.sessionId),
  stateVersion: ReviewSessionStateVersion.make(identity.stateVersion),
})

const toBrowserState = (state: CoreReviewSessionState): ReviewSessionState => {
  const identity = toBrowserIdentity(state.identity)
  return Match.valueTags(state, {
    Negotiating: () => ({ _tag: "negotiation" as const, identity }),
    Reserved: () => ({ _tag: "reservation" as const, identity }),
    Indexing: (current) => ({
      _tag: "indexing" as const,
      identity,
      completedUnits: current.completedUnits,
      totalUnits: current.totalUnits,
    }),
    Verifying: () => ({ _tag: "verification" as const, identity }),
    Ready: () => ({ _tag: "ready" as const, identity }),
    Invalidated: (current) => ({
      _tag: "invalidated" as const,
      identity,
      reason: current.reason,
    }),
    Failed: (current) => ({
      _tag: "failed" as const,
      identity,
      code: current.code,
      safeMessage: current.safeMessage,
      retryable: current.retryable,
    }),
    Disposed: (current) => ({
      _tag: "disposed" as const,
      identity,
      reason: current.reason,
    }),
  })
}

const toBrowserRange = (range: CoreReviewRange) => ({
  identity: toBrowserIdentity(range.identity),
  file: range.file,
  blocks: range.blocks,
  byteCount: range.byteCount,
  complete: range.complete,
})

const toBrowserSearchPublication = (
  publication: CoreReviewSearchPublication,
): ReviewSessionSearchPublication =>
  Match.valueTags(publication, {
    Provisional: (current) => ({
      ...current,
      identity: toBrowserIdentity(current.identity),
    }),
    Final: (current) => ({
      ...current,
      identity: toBrowserIdentity(current.identity),
    }),
  })
