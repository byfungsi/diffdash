import type {
  CodeWorkspaceDirectoryPage,
  CodeWorkspaceFileReadResult,
  CodeWorkspaceLease,
  CodeWorkspaceLeaseId,
  CodeWorkspaceSearchResult,
  CodeWorkspaceTarget,
} from "@diffdash/domain/code-workspace"
import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { Context, Effect, Layer } from "effect"

import { PreloadClient } from "./preload-client"
import { invokePreload, type RendererApiError } from "./renderer-api-error"

/** Renderer capability for one leased, isolated project Code workspace. */
export class CodeWorkspace extends Context.Service<
  CodeWorkspace,
  {
    readonly open: (
      target: CodeWorkspaceTarget,
    ) => Effect.Effect<CodeWorkspaceLease, RendererApiError>
    readonly heartbeat: (
      leaseId: CodeWorkspaceLeaseId,
    ) => Effect.Effect<CodeWorkspaceLease, RendererApiError>
    readonly release: (leaseId: CodeWorkspaceLeaseId) => Effect.Effect<void, RendererApiError>
    readonly listDirectory: (
      leaseId: CodeWorkspaceLeaseId,
      path: RepositoryRelativePath | null,
      offset: number,
      limit: number,
    ) => Effect.Effect<CodeWorkspaceDirectoryPage, RendererApiError>
    readonly search: (
      leaseId: CodeWorkspaceLeaseId,
      query: string,
      offset: number,
      limit: number,
    ) => Effect.Effect<CodeWorkspaceSearchResult, RendererApiError>
    readonly readFile: (
      leaseId: CodeWorkspaceLeaseId,
      path: RepositoryRelativePath,
    ) => Effect.Effect<CodeWorkspaceFileReadResult, RendererApiError>
  }
>()("@diffdash/app/CodeWorkspace") {}

/** Desktop implementation of the managed Code workspace renderer capability. */
export const codeWorkspaceLayer = Layer.effect(
  CodeWorkspace,
  Effect.gen(function* () {
    const api = yield* PreloadClient
    return CodeWorkspace.of({
      open: Effect.fn("CodeWorkspace.open")((target: CodeWorkspaceTarget) =>
        invokePreload(InvokeChannel.openCodeWorkspace, () => api.codeWorkspace.open({ target })),
      ),
      heartbeat: Effect.fn("CodeWorkspace.heartbeat")((leaseId: CodeWorkspaceLeaseId) =>
        invokePreload(InvokeChannel.heartbeatCodeWorkspace, () =>
          api.codeWorkspace.heartbeat({ leaseId }),
        ),
      ),
      release: Effect.fn("CodeWorkspace.release")((leaseId: CodeWorkspaceLeaseId) =>
        invokePreload(InvokeChannel.releaseCodeWorkspace, () =>
          api.codeWorkspace.release({ leaseId }),
        ),
      ),
      listDirectory: Effect.fn("CodeWorkspace.listDirectory")(
        (leaseId: CodeWorkspaceLeaseId, path, offset, limit) =>
          invokePreload(InvokeChannel.listCodeWorkspaceDirectory, () =>
            api.codeWorkspace.listDirectory({ leaseId, path, offset, limit }),
          ),
      ),
      search: Effect.fn("CodeWorkspace.search")((leaseId, query, offset, limit) =>
        invokePreload(InvokeChannel.searchCodeWorkspace, () =>
          api.codeWorkspace.search({ leaseId, query, offset, limit }),
        ),
      ),
      readFile: Effect.fn("CodeWorkspace.readFile")((leaseId, path) =>
        invokePreload(InvokeChannel.readCodeWorkspaceFile, () =>
          api.codeWorkspace.readFile({ leaseId, path }),
        ),
      ),
    })
  }),
)
