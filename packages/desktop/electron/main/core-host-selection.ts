import { Effect, Schema } from "effect"
import type {
  CoreAuthorizeDatabaseOwnershipFailure,
  CoreTransportAuthenticationFailure,
} from "@diffdash/core-rpc/failure"
import type {
  AuthorizeDatabaseOwnershipRequest,
  DatabaseOwnershipAuthorized,
} from "@diffdash/core-rpc/lifecycle"
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError"

import { BunQualificationCapability, type BunRuntimeQualificationError } from "./core-bun-runtime"
import type { CoreHostBootstrapSession } from "./core-host-bootstrap"

/** Desktop policy selecting the Core process runtime. */
export const CoreHostMode = Schema.Literals(["auto", "bun", "utility"])

/** Desktop policy selecting the Core process runtime. */
export type CoreHostMode = typeof CoreHostMode.Type

/** Runtime hosting one standalone Core process. */
export const CoreHostKind = Schema.Literals(["bun", "utility"])

/** Runtime hosting one standalone Core process. */
export type CoreHostKind = typeof CoreHostKind.Type

/** Sanitized failure after host qualification or startup candidates are exhausted. */
export class CoreHostSelectionError extends Schema.TaggedError<CoreHostSelectionError>()(
  "CoreHostSelectionError",
  {
    mode: CoreHostMode,
    host: Schema.NullOr(CoreHostKind),
    reason: Schema.Literals(["qualification-failed", "startup-failed", "fallback-disabled"]),
    qualificationCapability: Schema.NullOr(BunQualificationCapability),
    safeMessage: Schema.Literal("DiffDash Core is unavailable."),
  },
) {}

/** Sanitized failure from a concrete Core host candidate or fallback latch adapter. */
export class CoreHostCandidateError extends Schema.TaggedError<CoreHostCandidateError>()(
  "CoreHostCandidateError",
  {
    reason: Schema.Literals(["qualification-failed", "startup-failed", "latch-failed"]),
    qualificationCapability: Schema.NullOr(BunQualificationCapability),
    safeMessage: Schema.Literal("DiffDash could not prepare a Core host candidate."),
  },
) {}

/** Maps a Bun probe rejection into the selector's candidate boundary. */
export const bunQualificationCandidateError = (
  error: BunRuntimeQualificationError,
): CoreHostCandidateError =>
  CoreHostCandidateError.make({
    reason: "qualification-failed",
    qualificationCapability: error.capability,
    safeMessage: "DiffDash could not prepare a Core host candidate.",
  })

/** Maps a sanitized host startup rejection into the selector's candidate boundary. */
export const coreHostStartupCandidateError = (): CoreHostCandidateError =>
  CoreHostCandidateError.make({
    reason: "startup-failed",
    qualificationCapability: null,
    safeMessage: "DiffDash could not prepare a Core host candidate.",
  })

/** Persistent boundary that must close before database ownership authorization begins. */
export interface CoreHostFallbackLatch {
  readonly fallbackAllowed: Effect.Effect<boolean>
  readonly disableBeforeOwnershipAuthorization: Effect.Effect<void, CoreHostCandidateError>
}

/** One host implementation offered to the runtime selector. */
export interface CoreHostCandidate {
  readonly host: CoreHostKind
  readonly qualify: Effect.Effect<void, CoreHostCandidateError>
  readonly start: Effect.Effect<CoreHostBootstrapSession, CoreHostCandidateError>
}

/** Selected host session and the mandatory pre-ownership fallback boundary. */
export interface SelectedCoreHost {
  readonly host: CoreHostKind
  readonly session: CoreHostBootstrapSession
  readonly authorizeDatabaseOwnership: (
    request: AuthorizeDatabaseOwnershipRequest,
  ) => Effect.Effect<
    DatabaseOwnershipAuthorized,
    | CoreHostSelectionError
    | CoreAuthorizeDatabaseOwnershipFailure
    | CoreTransportAuthenticationFailure
    | RpcClientError
  >
}

/** Selects automatic or forced Core hosting without authorizing database ownership. */
export const selectCoreHost = Effect.fn("selectCoreHost")(function* (
  mode: CoreHostMode,
  candidates: ReadonlyArray<CoreHostCandidate>,
  fallbackLatch: CoreHostFallbackLatch,
) {
  const eligible =
    mode === "auto"
      ? [
          ...candidates.filter(({ host }) => host === "bun"),
          ...candidates.filter(({ host }) => host === "utility"),
        ]
      : candidates.filter(({ host }) => host === mode)
  let lastHost: CoreHostKind | null = null
  let lastReason: CoreHostSelectionError["reason"] = "startup-failed"
  let lastQualificationCapability: BunQualificationCapability | null = null

  for (const candidate of eligible) {
    lastHost = candidate.host
    const qualified = yield* candidate.qualify.pipe(
      Effect.as({ ok: true } as const),
      Effect.catch((error) => Effect.succeed({ ok: false, error } as const)),
    )
    if (!qualified.ok) {
      lastReason = "qualification-failed"
      lastQualificationCapability = qualified.error.qualificationCapability
      if (mode === "auto") {
        if (!(yield* fallbackLatch.fallbackAllowed)) {
          lastReason = "fallback-disabled"
          break
        }
      }
      continue
    }

    const session = yield* candidate.start.pipe(
      Effect.retry({ times: 2 }),
      Effect.map((value) => ({ ok: true, value }) as const),
      Effect.catch((error) => Effect.succeed({ ok: false, error } as const)),
    )
    if (session.ok) {
      return {
        host: candidate.host,
        session: session.value,
        authorizeDatabaseOwnership: (request) =>
          fallbackLatch.disableBeforeOwnershipAuthorization.pipe(
            Effect.mapError(() =>
              CoreHostSelectionError.make({
                mode,
                host: candidate.host,
                reason: "fallback-disabled",
                qualificationCapability: null,
                safeMessage: "DiffDash Core is unavailable.",
              }),
            ),
            Effect.andThen(session.value.authorizeDatabaseOwnership(request)),
          ),
      } satisfies SelectedCoreHost
    }
    lastReason = "startup-failed"
    lastQualificationCapability = null
    if (mode === "auto") {
      if (!(yield* fallbackLatch.fallbackAllowed)) {
        lastReason = "fallback-disabled"
        break
      }
    }
  }

  return yield* CoreHostSelectionError.make({
    mode,
    host: lastHost,
    reason: lastReason,
    qualificationCapability: lastQualificationCapability,
    safeMessage: "DiffDash Core is unavailable.",
  })
})
