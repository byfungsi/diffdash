import {
  CoreHostCapability,
  CoreHostCapabilityAllowlist,
  CoreHostCapabilityFailure,
  CoreHostCapabilityRpcs,
  type CoreHostCapabilityMethod,
  type HostOpenExternalRequest,
  type HostOpenPathRequest,
} from "@diffdash/core-rpc/host-capability"
import type {
  ApplicationInstanceId,
  CoreProcessEpoch,
  CoreRequestContext,
} from "@diffdash/core-rpc/identity"
import {
  getCoreRpcMethodPolicy,
  type CoreHostCapabilityName,
  type CoreRpcMethodPolicy,
} from "@diffdash/core-rpc/method-policy"
import { Effect, Option, Predicate, Semaphore } from "effect"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"

/** Native Electron operations available to the closed Core reverse-RPC audience. */
export interface CoreHostNativeCapabilities {
  readonly openExternal: (url: string) => Effect.Effect<void>
  readonly openPath: (path: string) => Effect.Effect<void>
}

/** Identity and authorization state enforced before Electron executes reverse RPC. */
export interface CoreHostCapabilityGatewayOptions {
  readonly applicationInstanceId: ApplicationInstanceId
  readonly processEpoch: CoreProcessEpoch
  readonly authorizedScopes: ReadonlySet<CoreRpcMethodPolicy["requiredScope"]>
  readonly availableCapabilities: ReadonlySet<CoreHostCapabilityName>
  readonly native: CoreHostNativeCapabilities
}

type CoreHostCapabilityRequest = HostOpenExternalRequest | HostOpenPathRequest

const encodedBytes = (value: CoreHostCapabilityRequest | undefined): number => {
  const encoded = RpcSerialization.makeMsgPack({ useRecords: true }).makeUnsafe().encode(value)
  if (encoded === undefined) return 0
  return Predicate.isString(encoded) ? Buffer.byteLength(encoded) : encoded.byteLength
}

const failure = (
  method: CoreHostCapabilityMethod,
  context: CoreRequestContext,
  code: CoreHostCapabilityFailure["code"],
  safeMessage: string,
): CoreHostCapabilityFailure =>
  CoreHostCapabilityFailure.make({
    _tag: "CoreHostCapabilityFailure",
    method,
    applicationInstanceId: context.applicationInstanceId,
    processEpoch: context.processEpoch,
    requestId: context.requestId,
    code,
    retryClass: code === "HOST_CAPABILITY_DEADLINE_EXCEEDED" ? "automatic" : "notRetryable",
    safeMessage,
  })

const policyIsCoherent = (policy: CoreRpcMethodPolicy): boolean =>
  policy.cancellation === "interruptible" &&
  policy.requiredScope === "application" &&
  policy.mutationClass === "uncertainMutation" &&
  policy.idempotency === "nonIdempotent" &&
  policy.restartBehavior === "failOnRestart" &&
  policy.requiredHostCapabilities.length === 1

/** Builds the only Electron handlers allowed to execute Core-originated native requests. */
export const coreHostCapabilityGatewayLayer = (options: CoreHostCapabilityGatewayOptions) => {
  return CoreHostCapabilityRpcs.toLayer(
    Effect.gen(function* () {
      const capacity = yield* Semaphore.make(32)
      const execute = Effect.fn("CoreHostCapabilityGateway.execute")(function* (
        method: CoreHostCapabilityMethod,
        context: CoreRequestContext,
        request: CoreHostCapabilityRequest,
        action: Effect.Effect<void>,
      ) {
        const declaration = CoreHostCapabilityRpcs.requests.get(method)
        const policy =
          declaration === undefined ? Option.none() : getCoreRpcMethodPolicy(declaration)
        const reject = (safeMessage: string) =>
          Effect.fail(failure(method, context, "HOST_CAPABILITY_REJECTED", safeMessage))

        if (!CoreHostCapabilityAllowlist.has(method) || Option.isNone(policy)) {
          return yield* reject("DiffDash rejected an unknown native host capability.")
        }
        if (
          context.applicationInstanceId !== options.applicationInstanceId ||
          context.processEpoch !== options.processEpoch
        ) {
          return yield* reject("DiffDash rejected a native request from a stale Core process.")
        }
        if (!policyIsCoherent(policy.value)) {
          return yield* reject("DiffDash rejected an invalid native host capability policy.")
        }
        if (!options.authorizedScopes.has(policy.value.requiredScope)) {
          return yield* reject("DiffDash rejected an unauthorized native host capability scope.")
        }
        if (
          policy.value.requiredHostCapabilities.some(
            (capability) => !options.availableCapabilities.has(capability),
          )
        ) {
          return yield* reject("DiffDash rejected an unavailable native host capability.")
        }
        if (encodedBytes(request) > policy.value.maxRequestBytes) {
          return yield* reject("DiffDash rejected an oversized native host capability request.")
        }
        const acquired = yield* capacity.takeIfAvailable(1)
        if (!acquired) {
          return yield* reject("DiffDash has no capacity for another native host request.")
        }

        yield* action.pipe(
          Effect.timeout(policy.value.deadlineMs),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(
              failure(
                method,
                context,
                "HOST_CAPABILITY_DEADLINE_EXCEEDED",
                "DiffDash timed out while executing a native host capability.",
              ),
            ),
          ),
          Effect.catchDefect(() =>
            Effect.fail(
              failure(
                method,
                context,
                "HOST_CAPABILITY_FAILED",
                "DiffDash could not execute the requested native host capability.",
              ),
            ),
          ),
          Effect.ensuring(capacity.release(1)),
        )
        if (encodedBytes(undefined) > policy.value.maxResponseBytes) {
          return yield* reject("DiffDash rejected an oversized native host capability response.")
        }
        return yield* Effect.void
      })

      return {
        "Host.openExternal": (request) =>
          execute(
            "Host.openExternal",
            request.context,
            request,
            options.native.openExternal(request.url),
          ),
        "Host.openPath": (request) =>
          execute("Host.openPath", request.context, request, options.native.openPath(request.path)),
      }
    }),
  )
}

/** Complete native capability set used by the production reverse gateway. */
export const CoreHostNativeCapabilitySet: ReadonlySet<CoreHostCapabilityName> = new Set([
  CoreHostCapability.openExternal,
  CoreHostCapability.openPath,
])
