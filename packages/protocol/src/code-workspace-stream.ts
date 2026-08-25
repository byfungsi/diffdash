import { CodeWorkspaceLeaseId } from "@diffdash/domain/code-workspace"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  LOCAL_CHECKOUT_FILE_MAX_BYTES,
  LocalCheckoutFileReadRejectionReason,
} from "@diffdash/domain/local-checkout-file"
import { Schema } from "effect"

import { TransportErrorPayload } from "./transport-error"

/** Maximum encoded request bytes accepted when opening a Code file stream. */
export const CODE_WORKSPACE_FILE_STREAM_REQUEST_BYTES = 8 * 1_024

/** Maximum encoded bytes accepted for one Code file stream message. */
export const CODE_WORKSPACE_FILE_STREAM_MESSAGE_BYTES = 384 * 1_024

/** Maximum aggregate source-file bytes accepted across one stream. */
export const CODE_WORKSPACE_FILE_STREAM_MAX_BYTES = LOCAL_CHECKOUT_FILE_MAX_BYTES

/** Request sent with the renderer-owned MessagePort for one Code file stream. */
export const CodeWorkspaceFileStreamRequest = Schema.Struct({
  leaseId: CodeWorkspaceLeaseId,
  path: RepositoryRelativePath,
})

/** Request sent with the renderer-owned MessagePort for one Code file stream. */
export type CodeWorkspaceFileStreamRequest = typeof CodeWorkspaceFileStreamRequest.Type

/** Pull-based flow-control messages sent from preload to Electron main. */
export const CodeWorkspaceFileStreamControl = Schema.TaggedUnion({
  Pull: {},
  Cancel: {},
})

/** Pull-based flow-control messages sent from preload to Electron main. */
export type CodeWorkspaceFileStreamControl = typeof CodeWorkspaceFileStreamControl.Type

/** Bounded stream messages sent from Electron main to preload. */
export const CodeWorkspaceFileStreamMessage = Schema.TaggedUnion({
  Chunk: { bytes: Schema.Uint8Array },
  End: {},
  Rejected: { path: RepositoryRelativePath, reason: LocalCheckoutFileReadRejectionReason },
  Failure: { error: TransportErrorPayload },
})

/** Bounded stream messages sent from Electron main to preload. */
export type CodeWorkspaceFileStreamMessage = typeof CodeWorkspaceFileStreamMessage.Type

/** One decoded binary chunk delivered by the Core Code workspace stream. */
export type CodeWorkspaceFileChunk =
  import("@diffdash/domain/local-checkout-file").LocalCheckoutFileChunk

/** Cancels one active preload-owned Code workspace file stream. */
export type CodeWorkspaceFileStreamCancellation = () => void

/** Receives the cancellation capability for one preload-owned Code workspace file stream. */
export type CodeWorkspaceFileStreamCancellationRegistrar = (
  cancel: CodeWorkspaceFileStreamCancellation,
) => void
