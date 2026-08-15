import { ReviewKey, ReviewProjectId, ReviewSnapshotId } from "@diffdash/domain/review-identity"
import {
  type CloseReviewSessionRequest,
  InvalidatedReviewSession,
  type OpenReviewSessionRequest,
  ReadyReviewSession,
  ReviewSessionId,
  ReviewSessionIdentity,
  ReviewSessionProcessId,
  type ReviewSessionState,
  ReviewSessionStateVersion,
} from "@diffdash/protocol/review-session"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  type ProgressiveReviewSessionResources,
  ProgressiveReviewSessionController,
  type ReviewSessionConnection,
  type ReviewSessionGateway,
} from "./progressive-review-session"
import { createPierreRangeShellPool } from "./pierre-loaded-range-adapter"
import { type ReviewCacheKind, ReviewRendererCaches } from "./review-global-virtualizer"
import { ReviewLoadScheduler } from "./review-load-scheduler"

const budgets: Readonly<Record<ReviewCacheKind, number>> = {
  text: 100,
  "syntax-ast": 100,
  "syntax-output": 100,
  annotation: 100,
  observer: 100,
  measurement: 100,
  reservation: 100,
  worker: 100,
  "dom-container": 100,
  prefetch: 100,
  pin: 100,
}

const request: OpenReviewSessionRequest = {
  projectId: ReviewProjectId.make("project-browser"),
  reviewKey: ReviewKey.make("review-browser"),
  snapshotId: ReviewSnapshotId.make("snapshot:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
}

class BrowserConnection implements ReviewSessionConnection {
  listener: ((state: ReviewSessionState) => void) | null = null

  constructor(private readonly initial: ReviewSessionState) {}

  readonly subscribe = (listener: (state: ReviewSessionState) => void): (() => void) => {
    this.listener = listener
    listener(this.initial)
    return () => {
      if (this.listener === listener) this.listener = null
    }
  }
}

afterEach(() => document.body.replaceChildren())

describe("ProgressiveReviewSessionController browser ownership", () => {
  it("releases pooled Pierre DOM and renderer cache ownership on invalidation", async () => {
    const identity = ReviewSessionIdentity.make({
      ...request,
      processId: ReviewSessionProcessId.make("process-browser"),
      sessionId: ReviewSessionId.make("session-browser"),
      stateVersion: ReviewSessionStateVersion.make(1),
    })
    const connection = new BrowserConnection(ReadyReviewSession.make({ identity }))
    const closed: CloseReviewSessionRequest[] = []
    const gateway: ReviewSessionGateway = {
      openSession: async () => connection,
      closeSession: async (closeRequest) => void closed.push(closeRequest),
    }
    const pool = createPierreRangeShellPool<string>(1)
    const shell = pool.acquire()
    document.body.append(shell.container)
    shell.container.append(document.createElement("span"))
    const caches = new ReviewRendererCaches(budgets)
    caches.put("browser-range", [{ kind: "text", bytes: 10, release: () => undefined }])
    const resources: ProgressiveReviewSessionResources = {
      loadScheduler: new ReviewLoadScheduler({
        maxConcurrency: 1,
        lanes: {
          target: { maxQueuedBytes: 1, maxConcurrency: 1, maxReservedOutputBytes: 1 },
          viewport: { maxQueuedBytes: 1, maxConcurrency: 1, maxReservedOutputBytes: 1 },
          prefetch: { maxQueuedBytes: 1, maxConcurrency: 1, maxReservedOutputBytes: 1 },
          background: { maxQueuedBytes: 1, maxConcurrency: 1, maxReservedOutputBytes: 1 },
        },
      }),
      rendererCaches: [caches],
      pierreAdapters: [{ dispose: () => pool.release(shell) }],
      pierreShellPools: [pool],
      snapshotPages: { dispose: () => undefined },
      navigator: { dispose: () => undefined },
      search: { dispose: () => undefined },
      highlights: [{ dispose: () => undefined }],
    }
    const controller = new ProgressiveReviewSessionController(gateway, () => resources)
    await controller.switchSession(request)

    connection.listener?.(
      InvalidatedReviewSession.make({
        identity: ReviewSessionIdentity.make({
          ...identity,
          stateVersion: ReviewSessionStateVersion.make(2),
        }),
        reason: "revisionChanged",
      }),
    )

    await vi.waitFor(() => expect(controller.diagnostics().active).toBe(false))
    expect(caches.bytes("text")).toBe(0)
    expect(pool.size).toBe(0)
    expect(document.body.childElementCount).toBe(0)
    expect(closed).toHaveLength(1)
  })
})
