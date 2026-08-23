import type { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc"
import { CodeWorkspaceError } from "@diffdash/domain/code-workspace"
import { Effect } from "effect"

import { CoreMethod, type CoreOperationOptions } from "../core-contract"
import { CodeWorkspaceService } from "../services/code-workspace"
import type { OperationHandlersFor } from "./operation-handlers"

type CodeWorkspaceMethod =
  | typeof CoreMethod.openCodeWorkspace
  | typeof CoreMethod.heartbeatCodeWorkspace
  | typeof CoreMethod.releaseCodeWorkspace
  | typeof CoreMethod.listCodeWorkspaceDirectory
  | typeof CoreMethod.searchCodeWorkspace
  | typeof CoreMethod.readCodeWorkspaceFile
  | typeof CoreMethod.codeWorkspaceDefinitions
  | typeof CoreMethod.codeWorkspaceReferences
  | typeof CoreMethod.codeWorkspaceChanges
  | typeof CoreMethod.codeWorkspaceLineChanges

/** Acquires all managed Code workspace operation handlers. */
export const makeCodeWorkspaceOperationHandlers: Effect.Effect<
  OperationHandlersFor<CodeWorkspaceMethod>,
  never,
  CodeWorkspaceService
> = Effect.gen(function* () {
  const workspaces = yield* CodeWorkspaceService
  return {
    [CoreMethod.openCodeWorkspace]: ({ target }, options) =>
      requireOwner(options).pipe(Effect.flatMap((owner) => workspaces.open(target, owner))),
    [CoreMethod.heartbeatCodeWorkspace]: ({ leaseId }, options) =>
      requireOwner(options).pipe(Effect.flatMap((owner) => workspaces.heartbeat(leaseId, owner))),
    [CoreMethod.releaseCodeWorkspace]: ({ leaseId }, options) =>
      requireOwner(options).pipe(Effect.flatMap((owner) => workspaces.release(leaseId, owner))),
    [CoreMethod.listCodeWorkspaceDirectory]: ({ leaseId, path, offset, limit }, options) =>
      requireOwner(options).pipe(
        Effect.flatMap((owner) => workspaces.listDirectory(leaseId, owner, path, offset, limit)),
      ),
    [CoreMethod.searchCodeWorkspace]: ({ leaseId, query, offset, limit }, options) =>
      requireOwner(options).pipe(
        Effect.flatMap((owner) => workspaces.search(leaseId, owner, query, offset, limit)),
      ),
    [CoreMethod.readCodeWorkspaceFile]: ({ leaseId, path }, options) =>
      requireOwner(options).pipe(
        Effect.flatMap((owner) => workspaces.readFile(leaseId, owner, path)),
      ),
    [CoreMethod.codeWorkspaceDefinitions]: ({ leaseId, path, position }, options) =>
      requireOwner(options).pipe(
        Effect.flatMap((owner) => workspaces.definitions(leaseId, owner, path, position)),
      ),
    [CoreMethod.codeWorkspaceReferences]: ({ leaseId, path, position }, options) =>
      requireOwner(options).pipe(
        Effect.flatMap((owner) => workspaces.references(leaseId, owner, path, position)),
      ),
    [CoreMethod.codeWorkspaceChanges]: ({ leaseId }, options) =>
      requireOwner(options).pipe(Effect.flatMap((owner) => workspaces.changes(leaseId, owner))),
    [CoreMethod.codeWorkspaceLineChanges]: ({ leaseId, path }, options) =>
      requireOwner(options).pipe(
        Effect.flatMap((owner) => workspaces.lineChanges(leaseId, owner, path)),
      ),
  }
})

const requireOwner = (
  options: CoreOperationOptions,
): Effect.Effect<
  {
    readonly applicationInstanceId: ApplicationInstanceId
    readonly processEpoch: CoreProcessEpoch
  },
  CodeWorkspaceError
> => {
  if (options.applicationInstanceId === undefined || options.processEpoch === undefined) {
    return Effect.fail(
      CodeWorkspaceError.make({
        operation: "authorize",
        reason: "workspaceUnavailable",
        message: "The managed Code workspace owner is unavailable.",
      }),
    )
  }
  return Effect.succeed({
    applicationInstanceId: options.applicationInstanceId,
    processEpoch: options.processEpoch,
  })
}
