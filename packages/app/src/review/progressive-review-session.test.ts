/* oxlint-disable eslint/no-await-in-loop -- Session switches must complete serially to verify each prior generation is empty. */
import { ReviewKey, ReviewProjectId, ReviewSnapshotId } from "@diffdash/domain/review-identity"
import {
  type CloseReviewSessionRequest,
  IndexingReviewSession,
  type OpenReviewSessionRequest,
  ReadyReviewSession,
  ReviewSessionId,
  ReviewSessionIdentity,
  ReviewSessionProcessId,
  type ReviewSessionState,
  ReviewSessionStateVersion,
  VerifyingReviewSession,
} from "@diffdash/protocol/review-session"
import { describe, expect, it } from "vitest"

import {
  type ProgressiveReviewSessionResources,
  ProgressiveReviewSessionController,
  type ReviewSessionConnection,
  type ReviewSessionGateway,
  type ReviewSessionPublicationCategory,
} from "./progressive-review-session"
import {
  type ReviewCacheKind,
  type ReviewCacheResource,
  ReviewRendererCaches,
} from "./review-global-virtualizer"
import {
  type ReviewLoadLane,
  type ReviewLoadSchedulerLimits,
  ReviewLoadScheduler,
} from "./review-load-scheduler"

const categories: readonly ReviewSessionPublicationCategory[] = [
  "text",
  "syntax",
  "measurements",
  "focus",
  "hints",
  "ownership",
]

const cacheKinds: readonly ReviewCacheKind[] = [
  "text",
  "syntax-ast",
  "syntax-output",
  "annotation",
  "observer",
  "measurement",
  "reservation",
  "worker",
  "dom-container",
  "prefetch",
  "pin",
]

const lanes: readonly ReviewLoadLane[] = ["target", "viewport", "prefetch", "background"]

const limits: ReviewLoadSchedulerLimits = {
  maxConcurrency: 1,
  lanes: {
    target: { maxQueuedBytes: 100, maxConcurrency: 1, maxReservedOutputBytes: 100 },
    viewport: { maxQueuedBytes: 100, maxConcurrency: 1, maxReservedOutputBytes: 100 },
    prefetch: { maxQueuedBytes: 100, maxConcurrency: 1, maxReservedOutputBytes: 100 },
    background: { maxQueuedBytes: 100, maxConcurrency: 1, maxReservedOutputBytes: 100 },
  },
}

const budgets: Readonly<Record<ReviewCacheKind, number>> = {
  text: 1_000,
  "syntax-ast": 1_000,
  "syntax-output": 1_000,
  annotation: 1_000,
  observer: 1_000,
  measurement: 1_000,
  reservation: 1_000,
  worker: 1_000,
  "dom-container": 1_000,
  prefetch: 1_000,
  pin: 1_000,
}

class RecordingConnection implements ReviewSessionConnection {
  readonly #listeners = new Set<(state: ReviewSessionState) => void>()

  constructor(private state: ReviewSessionState) {}

  readonly subscribe = (listener: (state: ReviewSessionState) => void): (() => void) => {
    this.#listeners.add(listener)
    listener(this.state)
    return () => this.#listeners.delete(listener)
  }

  readonly emit = (state: ReviewSessionState): void => {
    this.state = state
    for (const listener of this.#listeners) listener(state)
  }
}

class RecordingGateway implements ReviewSessionGateway {
  readonly closed: CloseReviewSessionRequest[] = []
  readonly connections: RecordingConnection[] = []
  #nextSession = 1

  readonly openSession = async (
    request: OpenReviewSessionRequest,
  ): Promise<ReviewSessionConnection> => {
    const identity = makeIdentity(request, this.#nextSession, 1)
    this.#nextSession += 1
    const connection = new RecordingConnection(
      IndexingReviewSession.make({ identity, completedUnits: 0, totalUnits: 1 }),
    )
    this.connections.push(connection)
    return connection
  }

  readonly closeSession = async (request: CloseReviewSessionRequest): Promise<void> => {
    this.closed.push(request)
  }
}

interface ResourceProbe {
  readonly caches: ReviewRendererCaches
  readonly scheduler: ReviewLoadScheduler
  readonly released: Set<string>
  readonly disposed: Set<string>
  readonly shells: { size: number; clear: () => void }
}

const makeResources = (probes: ResourceProbe[]): ProgressiveReviewSessionResources => {
  const scheduler = new ReviewLoadScheduler(limits)
  const caches = new ReviewRendererCaches(budgets)
  const released = new Set<string>()
  const resources: ReviewCacheResource[] = cacheKinds.map((kind) => ({
    kind,
    bytes: 1,
    release: () => released.add(kind),
  }))
  caches.put("owned-range", resources)
  scheduler.schedule({
    id: "active",
    lane: "target",
    kind: "read",
    queuedBytes: 1,
    reservedOutputBytes: 1,
    run: (signal) =>
      new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(new DOMException("aborted", "AbortError"))
        else
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      }),
  })
  scheduler.schedule({
    id: "queued-prefetch",
    lane: "prefetch",
    kind: "prefetch",
    queuedBytes: 1,
    reservedOutputBytes: 1,
    run: async () => undefined,
  })

  const disposed = new Set<string>()
  const disposable = (name: string) => ({ dispose: () => void disposed.add(name) })
  const shells = {
    size: 1,
    clear: () => {
      shells.size = 0
    },
  }
  probes.push({ caches, scheduler, released, disposed, shells })
  return {
    loadScheduler: scheduler,
    rendererCaches: [caches],
    pierreAdapters: [disposable("pierre")],
    pierreShellPools: [shells],
    snapshotPages: disposable("pages"),
    navigator: disposable("navigation"),
    search: disposable("search"),
    highlights: [disposable("highlights")],
  }
}

describe("ProgressiveReviewSessionController", () => {
  it("rejects every stale publication category under full identity and state-version ownership", async () => {
    const gateway = new RecordingGateway()
    const controller = new ProgressiveReviewSessionController(gateway, () => makeResources([]))
    const request = makeRequest(1)
    await controller.switchSession(request)
    const first = controller.diagnostics().state
    if (first === null) throw new Error("Expected an active session")
    const nextIdentity = ReviewSessionIdentity.make({
      ...first.identity,
      stateVersion: ReviewSessionStateVersion.make(2),
    })
    gateway.connections[0]?.emit(VerifyingReviewSession.make({ identity: nextIdentity }))

    let publications = 0
    for (const category of categories) {
      expect(controller.publish(category, first.identity, () => (publications += 1))).toBe(false)
    }
    expect(publications).toBe(0)
    expect(controller.diagnostics().rejectedPublications).toEqual(
      Object.fromEntries(categories.map((category) => [category, 1])),
    )

    const wrongProcess = ReviewSessionIdentity.make({
      ...nextIdentity,
      processId: ReviewSessionProcessId.make("stale-process"),
    })
    expect(controller.publish("ownership", wrongProcess, () => (publications += 1))).toBe(false)
    expect(controller.publish("text", nextIdentity, () => (publications += 1))).toBe(true)
    expect(publications).toBe(1)
    await controller.dispose()
  })

  it("keeps reads enabled while mutations remain gated through verification", async () => {
    const gateway = new RecordingGateway()
    const controller = new ProgressiveReviewSessionController(gateway, () => makeResources([]))
    await controller.switchSession(makeRequest(1))
    expect(controller.capabilities()).toMatchObject({
      committedContent: "readable",
      search: "indexing",
      mutations: "disabled",
    })
    const current = controller.diagnostics().state
    if (current === null) throw new Error("Expected an active session")
    const verifyingIdentity = nextVersion(current.identity)
    gateway.connections[0]?.emit(VerifyingReviewSession.make({ identity: verifyingIdentity }))
    expect(controller.capabilities()).toMatchObject({ search: "available", mutations: "disabled" })
    gateway.connections[0]?.emit(
      ReadyReviewSession.make({ identity: nextVersion(verifyingIdentity) }),
    )
    expect(controller.capabilities().mutations).toBe("enabled")
    await controller.dispose()
  })

  it("closes a slow open that resolves after a newer session owns the controller", async () => {
    const firstRequest = makeRequest(1)
    const firstIdentity = makeIdentity(firstRequest, 1, 1)
    const firstConnection = new RecordingConnection(
      IndexingReviewSession.make({
        identity: firstIdentity,
        completedUnits: 0,
        totalUnits: 1,
      }),
    )
    let resolveFirst: (connection: ReviewSessionConnection) => void = () => undefined
    let notifyOpened: () => void = () => undefined
    const firstOpened = new Promise<void>((resolve) => {
      notifyOpened = resolve
    })
    const openFirst = new Promise<ReviewSessionConnection>((resolve) => {
      resolveFirst = resolve
    })
    let openings = 0
    const closed: CloseReviewSessionRequest[] = []
    const gateway: ReviewSessionGateway = {
      openSession: async (request) => {
        openings += 1
        if (openings === 1) {
          notifyOpened()
          return openFirst
        }
        return new RecordingConnection(
          IndexingReviewSession.make({
            identity: makeIdentity(request, 2, 1),
            completedUnits: 0,
            totalUnits: 1,
          }),
        )
      },
      closeSession: async (request) => {
        closed.push(request)
      },
    }
    const controller = new ProgressiveReviewSessionController(gateway, () => makeResources([]))

    const superseded = controller.switchSession(firstRequest)
    await firstOpened
    await controller.switchSession(makeRequest(2))
    resolveFirst(firstConnection)
    await superseded

    expect(closed).toContainEqual({ identity: firstIdentity })
    expect(controller.diagnostics().state?.identity.reviewKey).toBe(makeRequest(2).reviewKey)
    await controller.dispose()
  })

  it("performs ten pathological switches with zero retained controller, cache, queue, or shell ownership", async () => {
    const gateway = new RecordingGateway()
    const probes: ResourceProbe[] = []
    const agentLeases = new Set(["agent-lease"])
    const controller = new ProgressiveReviewSessionController(gateway, () => makeResources(probes))

    for (let index = 0; index < 10; index += 1) {
      await controller.switchSession(makeRequest(index))
      await Promise.resolve()
      for (const probe of probes.slice(0, -1)) assertReleased(probe)
      expect(agentLeases).toEqual(new Set(["agent-lease"]))
    }
    await controller.dispose()
    await Promise.resolve()

    expect(probes).toHaveLength(10)
    for (const probe of probes) assertReleased(probe)
    expect(gateway.closed).toHaveLength(10)
    expect(controller.diagnostics().active).toBe(false)
    expect(agentLeases).toEqual(new Set(["agent-lease"]))
  })
})

const assertReleased = (probe: ResourceProbe): void => {
  for (const lane of lanes) {
    expect(probe.scheduler.pressure(lane)).toMatchObject({
      active: 0,
      queued: 0,
      queuedBytes: 0,
      reservedOutputBytes: 0,
    })
  }
  for (const kind of cacheKinds) {
    expect(probe.caches.bytes(kind)).toBe(0)
    expect(probe.released).toContain(kind)
  }
  expect(probe.disposed).toEqual(new Set(["pierre", "pages", "navigation", "search", "highlights"]))
  expect(probe.shells.size).toBe(0)
}

const makeRequest = (index: number): OpenReviewSessionRequest => ({
  projectId: ReviewProjectId.make(`project-${index}`),
  reviewKey: ReviewKey.make(`review-${index}`),
  snapshotId: ReviewSnapshotId.make(`snapshot:v1:${index.toString(16).padStart(32, "0")}`),
})

const makeIdentity = (
  request: OpenReviewSessionRequest,
  session: number,
  version: number,
): ReviewSessionIdentity =>
  ReviewSessionIdentity.make({
    ...request,
    processId: ReviewSessionProcessId.make("process-1"),
    sessionId: ReviewSessionId.make(`session-${session}`),
    stateVersion: ReviewSessionStateVersion.make(version),
  })

const nextVersion = (identity: ReviewSessionIdentity): ReviewSessionIdentity =>
  ReviewSessionIdentity.make({
    ...identity,
    stateVersion: ReviewSessionStateVersion.make(identity.stateVersion + 1),
  })
