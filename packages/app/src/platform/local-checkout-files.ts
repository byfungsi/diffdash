import type {
  LocalCheckoutFileListResult,
  LocalCheckoutFileReadResult,
} from "@diffdash/domain/local-checkout-file"
import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { Context, Effect, Layer } from "effect"

import { PreloadClient } from "./preload-client"
import { invokePreload, type RendererApiError } from "./renderer-api-error"

/** Renderer capability for bounded source inspection of persisted local checkouts. */
export class LocalCheckoutFiles extends Context.Service<
  LocalCheckoutFiles,
  {
    readonly list: (
      projectId: ReviewProjectId,
    ) => Effect.Effect<LocalCheckoutFileListResult, RendererApiError>
    readonly read: (
      projectId: ReviewProjectId,
      path: RepositoryRelativePath,
    ) => Effect.Effect<LocalCheckoutFileReadResult, RendererApiError>
  }
>()("@diffdash/app/LocalCheckoutFiles") {}

/** Desktop implementation of renderer local-checkout file capabilities. */
export const localCheckoutFilesLayer = Layer.effect(
  LocalCheckoutFiles,
  Effect.gen(function* () {
    const api = yield* PreloadClient
    const list = Effect.fn("LocalCheckoutFiles.list")((projectId: ReviewProjectId) =>
      invokePreload(InvokeChannel.listLocalCheckoutFiles, () =>
        api.localCheckoutFiles.list(projectId),
      ),
    )
    const read = Effect.fn("LocalCheckoutFiles.read")(
      (projectId: ReviewProjectId, path: RepositoryRelativePath) =>
        invokePreload(InvokeChannel.readLocalCheckoutFile, () =>
          api.localCheckoutFiles.read(projectId, path),
        ),
    )
    return LocalCheckoutFiles.of({ list, read })
  }),
)
