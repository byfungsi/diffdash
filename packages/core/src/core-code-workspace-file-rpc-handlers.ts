import {
  CoreCodeWorkspaceFileAdmissionMiddleware,
  CoreCodeWorkspaceFileRequest,
  CoreCodeWorkspaceFileRpcs,
} from "@diffdash/core-rpc/code-workspace-rpc"
import { getCoreRpcMethodPolicy } from "@diffdash/core-rpc/method-policy"
import { CodeWorkspaceError } from "@diffdash/domain/code-workspace"
import { Effect, Layer, Option, Schema, Stream } from "effect"

import { CoreLifecycle } from "./core-lifecycle"
import { CoreRuntimeServices } from "./core-runtime-services"

const handlerLayer = CoreCodeWorkspaceFileRpcs.toLayer(
  Effect.gen(function* () {
    const runtime = yield* CoreRuntimeServices
    return {
      "CodeWorkspace.streamFile": (request) =>
        Stream.unwrap(
          runtime.operations.pipe(
            Effect.map((operations) =>
              operations.streamCodeWorkspaceFile(
                request.leaseId,
                {
                  applicationInstanceId: request.applicationInstanceId,
                  processEpoch: request.processEpoch,
                },
                request.path,
              ),
            ),
          ),
        ),
    }
  }),
)

const admissionLayer = Layer.effect(
  CoreCodeWorkspaceFileAdmissionMiddleware,
  Effect.gen(function* () {
    const lifecycle = yield* CoreLifecycle
    return (effect, options) =>
      Schema.decodeUnknownEffect(CoreCodeWorkspaceFileRequest)(options.payload).pipe(
        Effect.orDie,
        Effect.flatMap((request) =>
          Effect.gen(function* () {
            const policy = yield* Option.match(getCoreRpcMethodPolicy(options.rpc), {
              onNone: () => Effect.die("Code workspace file RPC is missing its method policy."),
              onSome: Effect.succeed,
            })
            yield* lifecycle.admitBusinessRequest(request).pipe(
              Effect.mapError(() =>
                CodeWorkspaceError.make({
                  operation: "streamFile",
                  reason: "workspaceUnavailable",
                  message: "DiffDash Core is not ready to stream Code workspace files.",
                }),
              ),
            )
            return yield* lifecycle.interruptOnDrain(effect).pipe(
              Effect.timeoutOrElse({
                duration: policy.deadlineMs,
                orElse: () =>
                  Effect.fail(
                    CodeWorkspaceError.make({
                      operation: "streamFile",
                      reason: "workspaceUnavailable",
                      message: "The Code workspace file stream exceeded its deadline.",
                    }),
                  ),
              }),
            )
          }),
        ),
      )
  }),
)

/** Streams managed Code workspace files under lifecycle and deadline admission. */
export const coreCodeWorkspaceFileRpcHandlersLayer = Layer.merge(handlerLayer, admissionLayer)
