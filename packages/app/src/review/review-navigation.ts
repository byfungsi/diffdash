/* oxlint-disable eslint/no-await-in-loop, eslint/no-underscore-dangle -- Bounded retries are sequential; domain unions use Effect-compatible _tag discriminants. */
import type {
  ReviewFileId,
  ReviewProjectId,
  ReviewSnapshotId,
} from "@diffdash/domain/review-identity"
import {
  ActiveReviewNavigationStatus,
  CancelledReviewNavigationOutcome,
  CompletedReviewNavigationOutcome,
  FailedReviewNavigationOutcome,
  IdleReviewNavigationStatus,
  type ReviewLocationV1,
  type ReviewNavigationFailureReason,
  ReviewNavigationInput,
  type ReviewNavigationOutcome,
  type ReviewNavigationOrigin,
  type ReviewNavigationPhase,
  ReviewNavigationRequestId,
  type ReviewNavigationStatus,
  type ReviewNavigationTarget,
  type ReviewNavigationUnavailableReason,
  SupersededReviewNavigationOutcome,
  UnavailableReviewNavigationOutcome,
} from "@diffdash/domain/review-navigation"
import { isTransientTransportError } from "@diffdash/protocol/transport-error"
import { isAbortDOMException } from "@/shared/dom"
import { rendererFailureInput } from "@/shared/errors"
import { Equal, Match, Predicate, Result, Schema } from "effect"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"

/** Exact active review attached to the renderer-local navigator. */
export interface ReviewNavigationSession {
  readonly projectId: ReviewProjectId
  readonly snapshotId: ReviewSnapshotId
}

/** Full ownership key required on every asynchronous coordinator event. */
export interface ReviewNavigationOperationKey extends ReviewNavigationSession {
  readonly sessionEpoch: number
  readonly bridgeEpoch: number
  readonly requestId: ReviewNavigationRequestId
}

/** Request plus local ownership and deadline metadata. */
export interface ReviewNavigationOperation {
  readonly key: ReviewNavigationOperationKey
  readonly input: ReviewNavigationInput
  readonly submittedAt: number
  readonly phaseStartedAt: number
  readonly deadlineAt: number
}

/** Attached review identity and lifecycle epochs. */
export interface ReviewNavigationContext extends ReviewNavigationSession {
  readonly sessionEpoch: number
  readonly bridgeEpoch: number
}

/** Private state-machine shape exported only for pure model tests. */
export type ReviewNavigationMachineState =
  | {
      readonly _tag: "detached"
      readonly reason: "no-review" | "review-loading" | "review-failed" | "bridge-lost"
    }
  | { readonly _tag: "idle"; readonly context: ReviewNavigationContext }
  | {
      readonly _tag: "active"
      readonly context: ReviewNavigationContext
      readonly operation: ReviewNavigationOperation
      readonly phase: ReviewNavigationPhase
    }

/** Request-owned presentation state consumed by review rendering. */
export interface ReviewNavigationPresentation {
  readonly requestId: ReviewNavigationRequestId | null
  readonly selectedFileId: ReviewFileId | null
  readonly forceVisibleFileIds: readonly ReviewFileId[]
  readonly forceExpandedFileIds: readonly ReviewFileId[]
  readonly pinnedFileIds: readonly ReviewFileId[]
  readonly activeTarget: ReviewNavigationTarget | null
}

/** Complete pure model updated atomically by navigation commands. */
export interface ReviewNavigationModel {
  readonly machine: ReviewNavigationMachineState
  readonly presentation: ReviewNavigationPresentation
  readonly lastOutcome: ReviewNavigationOutcome | null
  readonly nextSessionEpoch: number
  readonly nextBridgeEpoch: number
}

type ReviewNavigationCommand =
  | { readonly _tag: "attach"; readonly session: ReviewNavigationSession }
  | {
      readonly _tag: "detach"
      readonly reason: "no-review" | "review-loading" | "review-failed" | "bridge-lost"
    }
  | {
      readonly _tag: "submit"
      readonly input: ReviewNavigationInput
      readonly requestId: ReviewNavigationRequestId
      readonly now: number
      readonly deadlineMs: number
    }
  | {
      readonly _tag: "phase"
      readonly key: ReviewNavigationOperationKey
      readonly phase: ReviewNavigationPhase
      readonly now: number
    }
  | {
      readonly _tag: "resolved"
      readonly key: ReviewNavigationOperationKey
      readonly fileId: ReviewFileId | null
    }
  | {
      readonly _tag: "settle"
      readonly key: ReviewNavigationOperationKey
      readonly outcome: ReviewNavigationOutcome
    }
  | { readonly _tag: "cancel"; readonly reason: "caller" | "user" }
  | { readonly _tag: "record"; readonly outcome: ReviewNavigationOutcome }

interface ReviewNavigationCommandResult {
  readonly model: ReviewNavigationModel
  readonly accepted: ReviewNavigationOperation | null
  readonly outcomes: readonly ReviewNavigationOutcome[]
  readonly stale: boolean
}

const EMPTY_PRESENTATION: ReviewNavigationPresentation = {
  requestId: null,
  selectedFileId: null,
  forceVisibleFileIds: [],
  forceExpandedFileIds: [],
  pinnedFileIds: [],
  activeTarget: null,
}

/** Creates the deterministic detached model used by registries and reducer tests. */
export const makeInitialReviewNavigationModel = (): ReviewNavigationModel => ({
  machine: { _tag: "detached", reason: "no-review" },
  presentation: EMPTY_PRESENTATION,
  lastOutcome: null,
  nextSessionEpoch: 1,
  nextBridgeEpoch: 1,
})

/** Applies one navigation command without performing runtime or DOM work. */
export const reduceReviewNavigation = (
  model: ReviewNavigationModel,
  command: ReviewNavigationCommand,
): ReviewNavigationCommandResult =>
  Match.valueTags(command, {
    attach: (command) => {
      const outcomes = activeCancellation(
        model.machine,
        Match.valueTags(model.machine, {
          active: (machine) =>
            machine.context.projectId !== command.session.projectId ||
            machine.context.snapshotId !== command.session.snapshotId
              ? ("review-changed" as const)
              : ("bridge-lost" as const),
          detached: () => "bridge-lost" as const,
          idle: () => "bridge-lost" as const,
        }),
      )
      const context = {
        ...command.session,
        sessionEpoch: model.nextSessionEpoch,
        bridgeEpoch: model.nextBridgeEpoch,
      }
      return commandResult(
        {
          machine: { _tag: "idle", context },
          presentation: EMPTY_PRESENTATION,
          lastOutcome: outcomes.at(-1) ?? model.lastOutcome,
          nextSessionEpoch: model.nextSessionEpoch + 1,
          nextBridgeEpoch: model.nextBridgeEpoch + 1,
        },
        null,
        outcomes,
      )
    },
    detach: (command) => {
      const outcomes = activeCancellation(
        model.machine,
        command.reason === "bridge-lost" ? "bridge-lost" : "review-changed",
      )
      return commandResult(
        {
          ...model,
          machine: { _tag: "detached", reason: command.reason },
          presentation: EMPTY_PRESENTATION,
          lastOutcome: outcomes.at(-1) ?? model.lastOutcome,
        },
        null,
        outcomes,
      )
    },
    record: (command) =>
      commandResult({ ...model, lastOutcome: command.outcome }, null, [command.outcome]),
    cancel: (command) =>
      Match.valueTags(model.machine, {
        active: (machine) => {
          const outcome = CancelledReviewNavigationOutcome.make({
            requestId: machine.operation.key.requestId,
            reason: command.reason,
          })
          return commandResult(idleModel(model, machine.context, outcome), null, [outcome])
        },
        detached: () => staleCommand(model),
        idle: () => staleCommand(model),
      }),
    submit: (command) => {
      const superseded = Match.valueTags(model.machine, {
        active: (machine) => [
          SupersededReviewNavigationOutcome.make({
            requestId: machine.operation.key.requestId,
            by: command.requestId,
          }),
        ],
        detached: () => [],
        idle: () => [],
      })
      return Match.valueTags(model.machine, {
        detached: () => {
          const unavailable = UnavailableReviewNavigationOutcome.make({
            requestId: command.requestId,
            reason: "noActiveReview",
          })
          return commandResult({ ...model, lastOutcome: unavailable }, null, [
            ...superseded,
            unavailable,
          ])
        },
        idle: (machine) => submitWithContext(machine.context),
        active: (machine) => submitWithContext(machine.context),
      })

      function submitWithContext(context: ReviewNavigationContext): ReviewNavigationCommandResult {
        const mismatch = localLocationMismatch(command.input.location, context)
        if (mismatch !== null) {
          const unavailable = UnavailableReviewNavigationOutcome.make({
            requestId: command.requestId,
            reason: mismatch,
          })
          return commandResult(idleModel(model, context, unavailable), null, [
            ...superseded,
            unavailable,
          ])
        }

        const operation: ReviewNavigationOperation = {
          key: { ...context, requestId: command.requestId },
          input: command.input,
          submittedAt: command.now,
          phaseStartedAt: command.now,
          deadlineAt: command.now + command.deadlineMs,
        }
        const fileId = targetFileId(command.input.location.target)
        const presentation: ReviewNavigationPresentation = {
          requestId: command.requestId,
          selectedFileId: command.input.behavior.selection === "update" ? fileId : null,
          forceVisibleFileIds:
            command.input.behavior.visibility === "temporarily-reveal" && fileId !== null
              ? [fileId]
              : [],
          forceExpandedFileIds: fileId === null ? [] : [fileId],
          pinnedFileIds: fileId === null ? [] : [fileId],
          activeTarget: command.input.location.target,
        }
        return commandResult(
          {
            ...model,
            machine: { _tag: "active", context, operation, phase: "validating" },
            presentation,
            lastOutcome: superseded.at(-1) ?? model.lastOutcome,
          },
          operation,
          superseded,
        )
      }
    },
    phase: (command) =>
      Match.valueTags(model.machine, {
        active: (machine) => {
          if (!sameOperationKey(machine.operation.key, command.key)) return staleCommand(model)
          const operation = { ...machine.operation, phaseStartedAt: command.now }
          return commandResult(
            { ...model, machine: { ...machine, operation, phase: command.phase } },
            operation,
            [],
          )
        },
        detached: () => staleCommand(model),
        idle: () => staleCommand(model),
      }),
    resolved: (command) =>
      Match.valueTags(model.machine, {
        active: (machine) => {
          if (!sameOperationKey(machine.operation.key, command.key)) return staleCommand(model)
          if (command.fileId === null) return commandResult(model, machine.operation, [])
          const presentation = {
            ...model.presentation,
            selectedFileId:
              machine.operation.input.behavior.selection === "update"
                ? command.fileId
                : model.presentation.selectedFileId,
            forceVisibleFileIds:
              machine.operation.input.behavior.visibility === "temporarily-reveal"
                ? [command.fileId]
                : [],
            forceExpandedFileIds: [command.fileId],
            pinnedFileIds: [command.fileId],
          }
          return commandResult({ ...model, presentation }, machine.operation, [])
        },
        detached: () => staleCommand(model),
        idle: () => staleCommand(model),
      }),
    settle: (command) =>
      Match.valueTags(model.machine, {
        active: (machine) =>
          sameOperationKey(machine.operation.key, command.key)
            ? commandResult(idleModel(model, machine.context, command.outcome), null, [
                command.outcome,
              ])
            : staleCommand(model),
        detached: () => staleCommand(model),
        idle: () => staleCommand(model),
      }),
  })

const privateReviewNavigationModelAtom = Atom.make(makeInitialReviewNavigationModel())

const EMPTY_COMMAND_RESULT: ReviewNavigationCommandResult = {
  model: makeInitialReviewNavigationModel(),
  accepted: null,
  outcomes: [],
  stale: false,
}

const reviewNavigationCommandAtom = Atom.fnSync(
  (command: ReviewNavigationCommand, get) => {
    const result = reduceReviewNavigation(get(privateReviewNavigationModelAtom), command)
    get.set(privateReviewNavigationModelAtom, result.model)
    return result
  },
  { initialValue: EMPTY_COMMAND_RESULT },
)

/** Read-only current navigation status for status UI and external observers. */
export const reviewNavigationStatusAtom: Atom.Atom<ReviewNavigationStatus> = Atom.readable((get) =>
  projectReviewNavigationStatus(get(privateReviewNavigationModelAtom).machine),
).pipe(Atom.withEquality(Equal.equals))

/** Read-only most recent terminal navigation result. */
export const reviewNavigationLastOutcomeAtom: Atom.Atom<ReviewNavigationOutcome | null> =
  Atom.readable((get) => get(privateReviewNavigationModelAtom).lastOutcome)

/** Read-only request-owned presentation leases for review rendering. */
export const reviewNavigationPresentationAtom: Atom.Atom<ReviewNavigationPresentation> =
  Atom.readable((get) => get(privateReviewNavigationModelAtom).presentation)

/** Runtime target resolution returned by the imperative viewport bridge. */
export interface ResolvedReviewNavigationTarget {
  readonly target: ReviewNavigationTarget
  readonly fileId: ReviewFileId | null
  readonly anchorKey: string
}

/** Mounted runtime target handle; runtime resources never enter atoms. */
export interface MountedReviewAnchor {
  readonly generation: number
  readonly measure: () => DOMRect
  readonly focus?: () => boolean
  readonly ownsFocus?: (active: Element | null) => boolean
  readonly isConnected: () => boolean
}

/** Imperative review-scoped execution plane used by the atom coordinator. */
export interface ReviewViewportBridge {
  readonly resolveTarget: (
    target: ReviewNavigationTarget,
    signal: AbortSignal,
  ) => Promise<ResolvedReviewNavigationTarget>
  readonly loadTarget: (
    target: ResolvedReviewNavigationTarget,
    signal: AbortSignal,
  ) => Promise<void>
  readonly reacquireSnapshot: (
    expectedSnapshotId: ReviewSnapshotId,
    signal: AbortSignal,
  ) => Promise<ReviewSnapshotId>
  readonly prepareSurface: (
    target: ResolvedReviewNavigationTarget,
    input: ReviewNavigationInput,
    signal: AbortSignal,
  ) => Promise<void>
  readonly waitForAnchor: (
    target: ResolvedReviewNavigationTarget,
    signal: AbortSignal,
  ) => Promise<MountedReviewAnchor>
  readonly position: (
    anchor: MountedReviewAnchor,
    input: ReviewNavigationInput,
    signal: AbortSignal,
  ) => Promise<void>
  readonly activateWindow: (signal: AbortSignal) => Promise<void>
  readonly focus: (anchor: MountedReviewAnchor, signal: AbortSignal) => Promise<void>
  readonly verify: (
    anchor: MountedReviewAnchor,
    input: ReviewNavigationInput,
    signal: AbortSignal,
  ) => Promise<void>
}

/** Typed bridge failure converted into a deterministic unavailable outcome. */
export class ReviewNavigationUnavailableError extends Error {
  readonly reason: ReviewNavigationUnavailableReason

  constructor(reason: ReviewNavigationUnavailableReason) {
    super(reason)
    this.name = "ReviewNavigationUnavailableError"
    this.reason = reason
  }
}

/** Typed bridge signal requesting one exact snapshot reacquisition attempt. */
export class ReviewNavigationSnapshotExpiredError extends Error {
  constructor() {
    super("Review snapshot expired")
    this.name = "ReviewNavigationSnapshotExpiredError"
  }
}

/** Non-React review navigation capability shared by every review caller. */
export interface ReviewNavigator {
  readonly navigate: (input: ReviewNavigationInput) => Promise<ReviewNavigationOutcome>
  readonly cancelActive: () => void
  readonly cancelActiveForOrigins: (origins: readonly ReviewNavigationOrigin[]) => boolean
  readonly getStatus: () => ReviewNavigationStatus
  readonly subscribeStatus: (listener: (status: ReviewNavigationStatus) => void) => () => void
}

/** Wall-clock budgets used by local review navigation. */
export interface ReviewNavigationBudgets {
  readonly requestMs: number
  readonly hardCapMs: number
  readonly loadingResourceMs: number
  readonly snapshotReacquisitionMs: number
  readonly extensionResolutionMs: number
  readonly awaitingMountMs: number
  readonly positioningMs: number
  readonly activationAndFocusMs: number
  readonly transientRetryDelaysMs: readonly number[]
}

const DEFAULT_BUDGETS: ReviewNavigationBudgets = {
  requestMs: 20_000,
  hardCapMs: 60_000,
  loadingResourceMs: 15_000,
  snapshotReacquisitionMs: 15_000,
  extensionResolutionMs: 2_000,
  awaitingMountMs: 8_000,
  positioningMs: 2_000,
  activationAndFocusMs: 2_000,
  transientRetryDelaysMs: [100, 300],
}

const noop = (): void => undefined

/** Monotonic clock and cancellable timer seam used by every navigation budget. */
export interface ReviewNavigationScheduler {
  readonly now: () => number
  readonly schedule: (delayMs: number, task: () => void) => () => void
}

const DEFAULT_SCHEDULER: ReviewNavigationScheduler = {
  now: performance.now.bind(performance),
  schedule: (delayMs, task) => {
    const timer = setTimeout(task, delayMs)
    return () => clearTimeout(timer)
  },
}

class ReviewNavigationOperationalError extends Error {
  readonly reason: ReviewNavigationFailureReason
  readonly retryable: boolean

  constructor(reason: ReviewNavigationFailureReason, retryable: boolean) {
    super(reason)
    this.name = "ReviewNavigationOperationalError"
    this.reason = reason
    this.retryable = retryable
  }
}

/** Coordinates atom transitions, promise settlement, aborts, and the imperative bridge. */
export class ReviewNavigatorController implements ReviewNavigator {
  readonly #registry: AtomRegistry.AtomRegistry
  readonly #budgets: ReviewNavigationBudgets
  readonly #scheduler: ReviewNavigationScheduler
  readonly #releaseCommand: () => void
  readonly #releaseModel: () => void
  readonly #pending = new Map<
    ReviewNavigationRequestId,
    (outcome: ReviewNavigationOutcome) => void
  >()
  #bridge: ReviewViewportBridge | null = null
  #activeAbort: AbortController | null = null
  #activeDeadline: (() => void) | null = null
  #nextRequestId = 1
  #disposed = false

  constructor(
    registry: AtomRegistry.AtomRegistry,
    options: {
      readonly budgets?: Partial<ReviewNavigationBudgets>
      readonly scheduler?: ReviewNavigationScheduler
    } = {},
  ) {
    this.#registry = registry
    this.#budgets = { ...DEFAULT_BUDGETS, ...options.budgets }
    this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER
    assertNavigationBudgets(this.#budgets)
    this.#releaseModel = registry.mount(privateReviewNavigationModelAtom)
    this.#releaseCommand = registry.mount(reviewNavigationCommandAtom)
  }

  /** Attaches one mounted review and its bridge, replacing any previous session. */
  readonly attach = (session: ReviewNavigationSession, bridge: ReviewViewportBridge) => {
    this.#assertUsable()
    this.#bridge = bridge
    this.#abortActive()
    this.#dispatch({ _tag: "attach", session })
  }

  /** Detaches the mounted review and settles active work as a context change. */
  readonly detach = (reason: "no-review" | "review-loading" | "review-failed" | "bridge-lost") => {
    if (this.#disposed) return
    this.#bridge = null
    this.#abortActive()
    this.#dispatch({ _tag: "detach", reason })
  }

  /** Executes one selector-free request with latest-request-wins ownership. */
  readonly navigate = (input: ReviewNavigationInput): Promise<ReviewNavigationOutcome> => {
    this.#assertUsable()
    const requestId = ReviewNavigationRequestId.make(this.#nextRequestId)
    this.#nextRequestId += 1
    const decoded = Schema.decodeUnknownResult(ReviewNavigationInput)(input)
    if (Result.isFailure(decoded)) {
      const outcome = UnavailableReviewNavigationOutcome.make({
        requestId,
        reason: "invalidLocation",
      })
      this.#dispatch({ _tag: "record", outcome })
      return Promise.resolve(outcome)
    }

    const promise = new Promise<ReviewNavigationOutcome>((resolve) => {
      this.#pending.set(requestId, resolve)
    })
    const result = this.#dispatch({
      _tag: "submit",
      input: decoded.success,
      requestId,
      now: this.#scheduler.now(),
      deadlineMs: Math.min(this.#budgets.requestMs, this.#budgets.hardCapMs),
    })
    this.#abortActive()
    const accepted = result.accepted
    if (accepted !== null) {
      const abort = new AbortController()
      this.#activeAbort = abort
      this.#activeDeadline = this.#scheduler.schedule(
        Math.max(0, accepted.deadlineAt - this.#scheduler.now()),
        () => {
          abort.abort()
          const state = this.#registry.get(privateReviewNavigationModelAtom).machine
          Match.valueTags(state, {
            active: (state) => {
              if (!sameOperationKey(state.operation.key, accepted.key)) return
              this.#settle(
                accepted.key,
                FailedReviewNavigationOutcome.make({
                  requestId,
                  phase: state.phase,
                  reason: "deadlineExceeded",
                  retryable: true,
                }),
              )
            },
            detached: () => undefined,
            idle: () => undefined,
          })
        },
      )
      void this.#execute(accepted, abort.signal)
    }
    return promise
  }

  /** Cancels the current request without affecting user-owned review state. */
  readonly cancelActive = () => {
    if (this.#disposed) return
    this.#abortActive()
    this.#dispatch({ _tag: "cancel", reason: "caller" })
  }

  /** Cancels only when the active request belongs to one of the supplied surfaces. */
  readonly cancelActiveForOrigins = (origins: readonly ReviewNavigationOrigin[]) => {
    if (this.#disposed) return false
    const machine = this.#registry.get(privateReviewNavigationModelAtom).machine
    const canCancel = Match.valueTags(machine, {
      active: (machine) => origins.includes(machine.operation.input.origin),
      detached: () => false,
      idle: () => false,
    })
    if (!canCancel) return false
    this.cancelActive()
    return true
  }

  /** Cancels the current request specifically because of user input. */
  readonly cancelForUser = () => {
    if (this.#disposed) return
    this.#abortActive()
    this.#dispatch({ _tag: "cancel", reason: "user" })
  }

  /** Returns the current privacy-safe public status. */
  readonly getStatus = () => this.#registry.get(reviewNavigationStatusAtom)

  /** Observes public status without exposing writable atoms. */
  readonly subscribeStatus = (listener: (status: ReviewNavigationStatus) => void) =>
    this.#registry.subscribe(reviewNavigationStatusAtom, listener, { immediate: true })

  /** Releases registry mounts and terminally detaches this controller. */
  readonly dispose = () => {
    if (this.#disposed) return
    this.#disposed = true
    this.#bridge = null
    this.#abortActive()
    try {
      this.#dispatch({ _tag: "detach", reason: "bridge-lost" })
      this.#releaseCommand()
      this.#releaseModel()
    } catch {
      // The owning React registry may already have completed its delayed disposal.
    }
  }

  readonly #execute = async (operation: ReviewNavigationOperation, signal: AbortSignal) => {
    const bridge = this.#bridge
    if (bridge === null) {
      this.#settle(
        operation.key,
        CancelledReviewNavigationOutcome.make({
          requestId: operation.key.requestId,
          reason: "bridge-lost",
        }),
      )
      return
    }

    let phase: ReviewNavigationPhase = "validating"
    try {
      phase = "resolving"
      const target = await this.#runPhase(
        operation,
        phase,
        isExtensionNavigationTarget(operation.input.location.target)
          ? this.#budgets.extensionResolutionMs
          : this.#remainingRequestMs(operation),
        isExtensionNavigationTarget(operation.input.location.target)
          ? "extensionResolveFailed"
          : "positioningFailed",
        true,
        signal,
        (phaseSignal) =>
          this.#retryTransient(operation, phaseSignal, () =>
            bridge.resolveTarget(operation.input.location.target, phaseSignal),
          ),
      )
      this.#dispatch({ _tag: "resolved", key: operation.key, fileId: target.fileId })

      phase = "loading-resource"
      await this.#loadTarget(operation, bridge, target, signal)

      phase = "preparing-surface"
      await this.#runPhase(
        operation,
        phase,
        this.#remainingRequestMs(operation),
        "positioningFailed",
        true,
        signal,
        (phaseSignal) =>
          this.#retryTransient(operation, phaseSignal, () =>
            bridge.prepareSurface(target, operation.input, phaseSignal),
          ),
      )

      phase = "awaiting-mount"
      const anchor = await this.#runPhase(
        operation,
        phase,
        this.#budgets.awaitingMountMs,
        isExtensionNavigationTarget(target.target) ? "extensionMountFailed" : "positioningFailed",
        true,
        signal,
        (phaseSignal) =>
          this.#retryTransient(operation, phaseSignal, () =>
            bridge.waitForAnchor(target, phaseSignal),
          ),
      )

      const layoutDeadlineAt = Math.min(
        operation.deadlineAt,
        this.#scheduler.now() + this.#budgets.positioningMs,
      )
      phase = "positioning"
      await this.#runPhase(
        operation,
        phase,
        Math.max(0, layoutDeadlineAt - this.#scheduler.now()),
        "positioningFailed",
        true,
        signal,
        (phaseSignal) =>
          this.#retryTransient(operation, phaseSignal, () =>
            bridge.position(anchor, operation.input, phaseSignal),
          ),
      )

      if (operation.input.behavior.focus === "target") {
        const focusDeadlineAt = Math.min(
          operation.deadlineAt,
          this.#scheduler.now() + this.#budgets.activationAndFocusMs,
        )
        phase = "activating-window"
        await this.#runPhase(
          operation,
          phase,
          Math.max(0, focusDeadlineAt - this.#scheduler.now()),
          "windowActivationFailed",
          false,
          signal,
          (phaseSignal) =>
            this.#retryTransient(operation, phaseSignal, () => bridge.activateWindow(phaseSignal)),
        )
        phase = "focusing"
        await this.#runPhase(
          operation,
          phase,
          Math.max(0, focusDeadlineAt - this.#scheduler.now()),
          "focusFailed",
          false,
          signal,
          (phaseSignal) =>
            this.#retryTransient(operation, phaseSignal, () => bridge.focus(anchor, phaseSignal)),
        )
      }

      phase = "verifying"
      const verificationDeadlineAt = Math.min(
        operation.deadlineAt,
        this.#scheduler.now() + this.#budgets.positioningMs,
      )
      await this.#runPhase(
        operation,
        phase,
        Math.max(0, verificationDeadlineAt - this.#scheduler.now()),
        "positioningFailed",
        true,
        signal,
        (phaseSignal) =>
          this.#retryTransient(operation, phaseSignal, () =>
            bridge.verify(anchor, operation.input, phaseSignal),
          ),
      )
      this.#settle(
        operation.key,
        CompletedReviewNavigationOutcome.make({
          requestId: operation.key.requestId,
          achieved: operation.input.behavior.focus === "target" ? "focused" : "revealed",
        }),
      )
    } catch (error) {
      if (signal.aborted) return
      Match.value(error).pipe(
        Match.when(isReviewNavigationUnavailableError, (error) => {
          this.#settle(
            operation.key,
            UnavailableReviewNavigationOutcome.make({
              requestId: operation.key.requestId,
              reason: error.reason,
            }),
          )
        }),
        Match.when(isReviewNavigationOperationalError, (error) => {
          this.#settle(
            operation.key,
            FailedReviewNavigationOutcome.make({
              requestId: operation.key.requestId,
              phase,
              reason: error.reason,
              retryable: error.retryable,
            }),
          )
        }),
        Match.orElse(() => {
          this.#settle(
            operation.key,
            FailedReviewNavigationOutcome.make({
              requestId: operation.key.requestId,
              phase,
              reason: failureReasonForPhase(phase),
              retryable: phase !== "activating-window" && phase !== "focusing",
            }),
          )
        }),
      )
    }
  }

  readonly #loadTarget = async (
    operation: ReviewNavigationOperation,
    bridge: ReviewViewportBridge,
    target: ResolvedReviewNavigationTarget,
    signal: AbortSignal,
  ): Promise<void> => {
    let reacquired = false
    for (;;) {
      try {
        await this.#runPhase(
          operation,
          "loading-resource",
          this.#budgets.loadingResourceMs,
          "fileLoadFailed",
          true,
          signal,
          (phaseSignal) =>
            this.#retryTransient(operation, phaseSignal, () =>
              bridge.loadTarget(target, phaseSignal),
            ),
        )
        return
      } catch (error) {
        const snapshotExpired = Match.value(error).pipe(
          Match.when(isReviewNavigationSnapshotExpiredError, () => true),
          Match.orElse(() => false),
        )
        if (!snapshotExpired) throw error
        if (reacquired) {
          throw new ReviewNavigationOperationalError("snapshotLoadFailed", true)
        }
        const snapshotId = await this.#runPhase(
          operation,
          "loading-resource",
          this.#budgets.snapshotReacquisitionMs,
          "snapshotLoadFailed",
          true,
          signal,
          (phaseSignal) =>
            this.#retryTransient(operation, phaseSignal, () =>
              bridge.reacquireSnapshot(operation.key.snapshotId, phaseSignal),
            ),
        )
        if (snapshotId !== operation.key.snapshotId) {
          throw new ReviewNavigationUnavailableError("snapshotChanged")
        }
        reacquired = true
      }
    }
  }

  readonly #runPhase = async <Value>(
    operation: ReviewNavigationOperation,
    phase: ReviewNavigationPhase,
    budgetMs: number,
    failureReason: ReviewNavigationFailureReason,
    retryable: boolean,
    signal: AbortSignal,
    task: (phaseSignal: AbortSignal) => Promise<Value>,
  ): Promise<Value> => {
    this.#setPhase(operation.key, phase)
    this.#throwIfAborted(signal)
    const deadlineAt = Math.min(operation.deadlineAt, this.#scheduler.now() + Math.max(0, budgetMs))
    const timeoutReason = deadlineAt >= operation.deadlineAt ? "deadlineExceeded" : failureReason
    return new Promise<Value>((resolve, reject) => {
      let settled = false
      let cancelDeadline = noop
      const phaseAbort = new AbortController()
      const settle = (complete: () => void) => {
        if (settled) return
        settled = true
        cancelDeadline()
        signal.removeEventListener("abort", onAbort)
        complete()
      }
      const onAbort = () => {
        phaseAbort.abort()
        settle(() => reject(abortError()))
      }
      cancelDeadline = this.#scheduler.schedule(
        Math.max(0, deadlineAt - this.#scheduler.now()),
        () => {
          phaseAbort.abort()
          settle(() =>
            reject(
              new ReviewNavigationOperationalError(
                timeoutReason,
                timeoutReason === "deadlineExceeded" || retryable,
              ),
            ),
          )
        },
      )
      signal.addEventListener("abort", onAbort, { once: true })
      void task(phaseAbort.signal).then(
        (value) => settle(() => resolve(value)),
        <Value>(error: Value) =>
          settle(() => reject(normalizePhaseFailure(error, failureReason, retryable))),
      )
    })
  }

  readonly #retryTransient = async <Value>(
    operation: ReviewNavigationOperation,
    signal: AbortSignal,
    task: () => Promise<Value>,
  ): Promise<Value> => {
    for (const delayMs of [...this.#budgets.transientRetryDelaysMs, null]) {
      this.#throwIfAborted(signal)
      try {
        return await task()
      } catch (error) {
        if (!isTransientTransportError(rendererFailureInput(error)) || delayMs === null) throw error
        const remainingMs = operation.deadlineAt - this.#scheduler.now()
        if (remainingMs <= 0) {
          throw new ReviewNavigationOperationalError("deadlineExceeded", true)
        }
        await this.#sleep(Math.min(delayMs, remainingMs), signal)
      }
    }
    throw new Error("Unreachable navigation retry state")
  }

  readonly #sleep = (delayMs: number, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.reject(abortError())
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let cancelTimer = noop
      const settle = (complete: () => void) => {
        if (settled) return
        settled = true
        cancelTimer()
        signal.removeEventListener("abort", onAbort)
        complete()
      }
      const onAbort = () => settle(() => reject(abortError()))
      cancelTimer = this.#scheduler.schedule(delayMs, () => settle(resolve))
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  readonly #remainingRequestMs = (operation: ReviewNavigationOperation): number =>
    Math.max(0, operation.deadlineAt - this.#scheduler.now())

  readonly #setPhase = (key: ReviewNavigationOperationKey, phase: ReviewNavigationPhase) => {
    const result = this.#dispatch({ _tag: "phase", key, phase, now: this.#scheduler.now() })
    if (result.stale) throw new DOMException("Navigation superseded", "AbortError")
  }

  readonly #settle = (key: ReviewNavigationOperationKey, outcome: ReviewNavigationOutcome) => {
    const result = this.#dispatch({ _tag: "settle", key, outcome })
    if (!result.stale) this.#abortActive()
  }

  readonly #dispatch = (command: ReviewNavigationCommand) => {
    this.#registry.set(reviewNavigationCommandAtom, command)
    const result = this.#registry.get(reviewNavigationCommandAtom)
    for (const outcome of result.outcomes) {
      const resolve = this.#pending.get(outcome.requestId)
      if (resolve === undefined) continue
      this.#pending.delete(outcome.requestId)
      resolve(outcome)
    }
    return result
  }

  readonly #abortActive = () => {
    this.#activeAbort?.abort()
    this.#activeAbort = null
    this.#activeDeadline?.()
    this.#activeDeadline = null
  }

  readonly #throwIfAborted = (signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException("Navigation aborted", "AbortError")
  }

  readonly #assertUsable = () => {
    if (this.#disposed) throw new Error("ReviewNavigatorController is disposed")
  }
}

const projectReviewNavigationStatus = (
  machine: ReviewNavigationMachineState,
): ReviewNavigationStatus =>
  Match.valueTags(machine, {
    detached: () => IdleReviewNavigationStatus.make(),
    idle: () => IdleReviewNavigationStatus.make(),
    active: (machine) =>
      ActiveReviewNavigationStatus.make({
        requestId: machine.operation.key.requestId,
        phase: machine.phase,
        targetKind: Match.valueTags(machine.operation.input.location.target, {
          extension: () => "extension" as const,
          file: () => "file" as const,
          hunk: () => "hunk" as const,
          line: () => "line" as const,
          range: () => "range" as const,
          thread: () => "thread" as const,
        }),
        origin: machine.operation.input.origin,
        startedAt: machine.operation.submittedAt,
        phaseStartedAt: machine.operation.phaseStartedAt,
        viewportInput: "locked",
        canCancel: true,
      }),
  })

const localLocationMismatch = (
  location: ReviewLocationV1,
  context: ReviewNavigationContext,
): ReviewNavigationUnavailableReason | null => {
  if (location.version !== 1) return "unsupportedVersion"
  if (location.snapshot.projectId !== context.projectId) return "projectNotActive"
  if (location.snapshot.snapshotId !== context.snapshotId) return "snapshotNotActive"
  return null
}

const targetFileId = (target: ReviewNavigationTarget): ReviewFileId | null =>
  Match.valueTags(target, {
    extension: () => null,
    file: (target) => target.fileId,
    hunk: (target) => target.fileId,
    line: (target) => target.fileId,
    range: (target) => target.fileId,
    thread: () => null,
  })

const sameOperationKey = (
  left: ReviewNavigationOperationKey,
  right: ReviewNavigationOperationKey,
) =>
  left.sessionEpoch === right.sessionEpoch &&
  left.bridgeEpoch === right.bridgeEpoch &&
  left.requestId === right.requestId &&
  left.projectId === right.projectId &&
  left.snapshotId === right.snapshotId

const activeCancellation = (
  machine: ReviewNavigationMachineState,
  reason: "review-changed" | "bridge-lost",
): readonly ReviewNavigationOutcome[] =>
  Match.valueTags(machine, {
    active: (machine) => [
      CancelledReviewNavigationOutcome.make({
        requestId: machine.operation.key.requestId,
        reason,
      }),
    ],
    detached: () => [],
    idle: () => [],
  })

const idleModel = (
  model: ReviewNavigationModel,
  context: ReviewNavigationContext,
  outcome: ReviewNavigationOutcome,
): ReviewNavigationModel => ({
  ...model,
  machine: { _tag: "idle", context },
  presentation: EMPTY_PRESENTATION,
  lastOutcome: outcome,
})

const commandResult = (
  model: ReviewNavigationModel,
  accepted: ReviewNavigationOperation | null,
  outcomes: readonly ReviewNavigationOutcome[],
): ReviewNavigationCommandResult => ({ model, accepted, outcomes, stale: false })

const staleCommand = (model: ReviewNavigationModel): ReviewNavigationCommandResult => ({
  model,
  accepted: null,
  outcomes: [],
  stale: true,
})

const failureReasonForPhase = (
  phase: ReviewNavigationPhase,
): "fileLoadFailed" | "positioningFailed" | "windowActivationFailed" | "focusFailed" => {
  if (phase === "loading-resource") return "fileLoadFailed"
  if (phase === "activating-window") return "windowActivationFailed"
  if (phase === "focusing") return "focusFailed"
  return "positioningFailed"
}

const assertNavigationBudgets = (budgets: ReviewNavigationBudgets): void => {
  const durations = [
    budgets.requestMs,
    budgets.hardCapMs,
    budgets.loadingResourceMs,
    budgets.snapshotReacquisitionMs,
    budgets.extensionResolutionMs,
    budgets.awaitingMountMs,
    budgets.positioningMs,
    budgets.activationAndFocusMs,
  ]
  if (
    durations.some((duration) => !Number.isFinite(duration) || duration <= 0) ||
    budgets.transientRetryDelaysMs.some((delay) => !Number.isFinite(delay) || delay < 0)
  ) {
    throw new Error("Review navigation budgets must be finite positive durations")
  }
}

const isReviewNavigationUnavailableError = <Value>(
  value: Value,
): value is Value & ReviewNavigationUnavailableError =>
  Predicate.isObject(value) &&
  "name" in value &&
  value.name === "ReviewNavigationUnavailableError" &&
  "reason" in value &&
  Predicate.isString(value.reason)

const isReviewNavigationSnapshotExpiredError = <Value>(
  value: Value,
): value is Value & ReviewNavigationSnapshotExpiredError =>
  Predicate.isObject(value) &&
  "name" in value &&
  value.name === "ReviewNavigationSnapshotExpiredError"

const isReviewNavigationOperationalError = <Value>(
  value: Value,
): value is Value & ReviewNavigationOperationalError =>
  Predicate.isObject(value) &&
  "name" in value &&
  value.name === "ReviewNavigationOperationalError" &&
  "reason" in value &&
  Predicate.isString(value.reason) &&
  "retryable" in value &&
  Predicate.isBoolean(value.retryable)

const isExtensionNavigationTarget = (target: ReviewNavigationTarget): boolean =>
  Match.valueTags(target, {
    extension: () => true,
    file: () => false,
    hunk: () => false,
    line: () => false,
    range: () => false,
    thread: () => false,
  })

const normalizePhaseFailure = <Value>(
  error: Value,
  reason: ReviewNavigationFailureReason,
  retryable: boolean,
):
  | ReviewNavigationUnavailableError
  | ReviewNavigationSnapshotExpiredError
  | ReviewNavigationOperationalError
  | DOMException => {
  const input: object = Predicate.isObject(error) ? error : {}
  return Match.value(input).pipe(
    Match.when(isReviewNavigationUnavailableError, (error) => error),
    Match.when(isReviewNavigationSnapshotExpiredError, (error) => error),
    Match.when(isReviewNavigationOperationalError, (error) => error),
    Match.when(isAbortDOMException, (error) => error),
    Match.orElse(() => new ReviewNavigationOperationalError(reason, retryable)),
  )
}

const abortError = (): DOMException => new DOMException("Navigation aborted", "AbortError")
