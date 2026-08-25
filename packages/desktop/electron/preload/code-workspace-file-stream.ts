import {
  CodeWorkspaceFileContent,
  CodeWorkspaceFileReadRejected,
  type CodeWorkspaceFileReadRejectionReason,
} from "@diffdash/protocol/code-workspace"
import {
  CODE_WORKSPACE_FILE_STREAM_MESSAGE_BYTES,
  CODE_WORKSPACE_FILE_STREAM_MAX_BYTES,
  CODE_WORKSPACE_FILE_STREAM_REQUEST_BYTES,
  CodeWorkspaceFileStreamControl,
  type CodeWorkspaceFileStreamCancellationRegistrar,
  CodeWorkspaceFileStreamMessage,
  CodeWorkspaceFileStreamRequest,
} from "@diffdash/protocol/code-workspace-stream"
import { StreamChannel, InvokeChannel } from "@diffdash/protocol/channels"
import {
  bridgeResult,
  type EncodedBridgeResult,
  InvokeContract,
  invokeResponseSchema,
} from "@diffdash/protocol/ipc"
import { assertJsonPayloadWithinBudget } from "@diffdash/protocol/payload-budget"
import { TransportError, transportError } from "@diffdash/protocol/transport-error"
import { Schema } from "effect"

interface CodeWorkspaceFileStreamIpc {
  readonly postMessage: (
    channel: string,
    message: typeof CodeWorkspaceFileStreamRequest.Encoded,
    transfer: MessagePort[],
  ) => void
}

/** Reads one Code workspace file over a pull-driven Electron MessagePort stream. */
export const readCodeWorkspaceFileStream = (
  ipc: CodeWorkspaceFileStreamIpc,
  request: CodeWorkspaceFileStreamRequest,
  registerCancellation?: CodeWorkspaceFileStreamCancellationRegistrar,
): Promise<EncodedBridgeResult> => {
  const responseSchema = invokeResponseSchema(InvokeChannel.readCodeWorkspaceFile)
  const resultSchema = bridgeResult(responseSchema)
  const responseBudget = InvokeContract[InvokeChannel.readCodeWorkspaceFile].maxResponseBytes
  const success = (value: typeof responseSchema.Type): EncodedBridgeResult => {
    const encoded = Schema.encodeSync(resultSchema)({ _tag: "Success", value })
    assertJsonPayloadWithinBudget(encoded, responseBudget, StreamChannel.readCodeWorkspaceFile)
    return encoded
  }
  const failure = (error: TransportError): EncodedBridgeResult => {
    const encoded = Schema.encodeSync(resultSchema)({ _tag: "Failure", error })
    assertJsonPayloadWithinBudget(encoded, responseBudget, StreamChannel.readCodeWorkspaceFile)
    return encoded
  }

  return new Promise((resolve) => {
    let encodedRequest: typeof CodeWorkspaceFileStreamRequest.Encoded
    try {
      encodedRequest = Schema.encodeSync(CodeWorkspaceFileStreamRequest)(request)
      assertJsonPayloadWithinBudget(
        encodedRequest,
        CODE_WORKSPACE_FILE_STREAM_REQUEST_BYTES,
        StreamChannel.readCodeWorkspaceFile,
      )
    } catch {
      resolve(
        failure(
          transportError(
            "INVALID_REQUEST",
            "Invalid Code workspace file stream request.",
            StreamChannel.readCodeWorkspaceFile,
          ),
        ),
      )
      return
    }

    const channel = new MessageChannel()
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const chunks: string[] = []
    let receivedBytes = 0
    let settled = false
    const finish = (result: EncodedBridgeResult) => {
      if (settled) return
      settled = true
      channel.port2.close()
      resolve(result)
    }
    const cancelPort = () =>
      channel.port2.postMessage(
        Schema.encodeSync(CodeWorkspaceFileStreamControl)(
          CodeWorkspaceFileStreamControl.cases.Cancel.make({}),
        ),
      )
    registerCancellation?.(() => {
      if (settled) return
      cancelPort()
      finish(
        failure(
          transportError(
            "CANCELLED",
            "Code workspace file stream was cancelled.",
            StreamChannel.readCodeWorkspaceFile,
          ),
        ),
      )
    })
    const pull = () =>
      channel.port2.postMessage(
        Schema.encodeSync(CodeWorkspaceFileStreamControl)(
          CodeWorkspaceFileStreamControl.cases.Pull.make({}),
        ),
      )

    channel.port2.addEventListener("message", (event) => {
      try {
        assertJsonPayloadWithinBudget(
          event.data,
          CODE_WORKSPACE_FILE_STREAM_MESSAGE_BYTES,
          StreamChannel.readCodeWorkspaceFile,
        )
        const message = Schema.decodeUnknownSync(CodeWorkspaceFileStreamMessage)(event.data)
        CodeWorkspaceFileStreamMessage.match(message, {
          Chunk: ({ bytes }) => {
            receivedBytes += bytes.byteLength
            if (receivedBytes > CODE_WORKSPACE_FILE_STREAM_MAX_BYTES) {
              cancelPort()
              finish(
                failure(
                  transportError(
                    "PAYLOAD_TOO_LARGE",
                    "Code workspace file exceeded its byte limit.",
                    StreamChannel.readCodeWorkspaceFile,
                  ),
                ),
              )
              return
            }
            chunks.push(decoder.decode(bytes, { stream: true }))
            pull()
          },
          End: () => {
            chunks.push(decoder.decode())
            finish(
              success(
                CodeWorkspaceFileContent.make({ path: request.path, content: chunks.join("") }),
              ),
            )
          },
          Rejected: ({ path, reason }) => {
            const mappedReason: CodeWorkspaceFileReadRejectionReason =
              reason === "checkoutUnavailable" ||
              reason === "repositoryNotFound" ||
              reason === "repositoryUnavailable"
                ? "ioFailure"
                : reason
            finish(success(CodeWorkspaceFileReadRejected.make({ path, reason: mappedReason })))
          },
          Failure: ({ error }) => finish(failure(Schema.decodeUnknownSync(TransportError)(error))),
        })
      } catch {
        finish(
          failure(
            transportError(
              "INVALID_RESPONSE",
              "Invalid Code workspace file stream response.",
              StreamChannel.readCodeWorkspaceFile,
            ),
          ),
        )
      }
    })
    channel.port2.addEventListener("messageerror", () => {
      finish(
        failure(
          transportError(
            "INVALID_RESPONSE",
            "Invalid Code workspace file stream message.",
            StreamChannel.readCodeWorkspaceFile,
          ),
        ),
      )
    })
    channel.port2.start()
    try {
      ipc.postMessage(StreamChannel.readCodeWorkspaceFile, encodedRequest, [channel.port1])
      pull()
    } catch {
      finish(
        failure(
          transportError(
            "IPC_FAILURE",
            "DiffDash could not start the Code workspace file stream.",
            StreamChannel.readCodeWorkspaceFile,
          ),
        ),
      )
    }
  })
}
