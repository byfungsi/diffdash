import {
  CODE_WORKSPACE_FILE_STREAM_MESSAGE_BYTES,
  CODE_WORKSPACE_FILE_STREAM_REQUEST_BYTES,
  CodeWorkspaceFileStreamControl,
  CodeWorkspaceFileStreamMessage,
  CodeWorkspaceFileStreamRequest,
} from "@diffdash/protocol/code-workspace-stream"
import { StreamChannel } from "@diffdash/protocol/channels"
import { assertJsonPayloadWithinBudget } from "@diffdash/protocol/payload-budget"
import type { TransportError } from "@diffdash/protocol/transport-error"
import { LocalCheckoutFileReadError } from "@diffdash/core-rpc/code-workspace-rpc"
import { Option, Schema } from "effect"
import type { IpcMain, MessagePortMain } from "electron"
import { ipcMain } from "electron"

import type { ApplicationRuntime } from "../../application-runtime"
import type { RendererSecurityPolicy } from "../../electron-policy"
import { toPublicIpcError } from "../public-error"

/** Installs the pull-driven MessagePort bridge for streamed Code workspace files. */
export const installCodeWorkspaceFileStreamController = (
  runtime: ApplicationRuntime,
  rendererSecurityPolicy: RendererSecurityPolicy,
  ipc: Pick<IpcMain, "on"> = ipcMain,
) => {
  ipc.on(StreamChannel.readCodeWorkspaceFile, (event, rawRequest) => {
    const port = event.ports[0]
    if (port === undefined) return
    if (!rendererSecurityPolicy.isTrustedIpcSender(event)) {
      port.close()
      return
    }

    let request: CodeWorkspaceFileStreamRequest
    try {
      assertJsonPayloadWithinBudget(
        rawRequest,
        CODE_WORKSPACE_FILE_STREAM_REQUEST_BYTES,
        StreamChannel.readCodeWorkspaceFile,
      )
      request = Schema.decodeUnknownSync(CodeWorkspaceFileStreamRequest)(rawRequest)
    } catch (error) {
      sendFailure(port, toPublicIpcError(error, StreamChannel.readCodeWorkspaceFile))
      port.close()
      return
    }
    streamFile(runtime, request, port)
  })
}

const streamFile = (
  runtime: ApplicationRuntime,
  request: CodeWorkspaceFileStreamRequest,
  port: MessagePortMain,
) => {
  const iterator = runtime.codeWorkspaceFiles.stream(request)[Symbol.asyncIterator]()
  let closed = false
  let reading = false

  const close = () => {
    if (closed) return
    closed = true
    port.close()
  }
  const cancel = () => {
    if (closed) return
    closed = true
    void iterator.return?.().finally(() => port.close())
  }
  const pull = async () => {
    if (closed || reading) return
    reading = true
    try {
      const next = await iterator.next()
      if (closed) return
      if (next.done) {
        send(port, CodeWorkspaceFileStreamMessage.cases.End.make({}))
        close()
        return
      }
      send(port, CodeWorkspaceFileStreamMessage.cases.Chunk.make({ bytes: next.value.bytes }))
    } catch (error) {
      if (!closed) {
        if (Schema.is(LocalCheckoutFileReadError)(error)) {
          send(
            port,
            CodeWorkspaceFileStreamMessage.cases.Rejected.make({
              path: error.path,
              reason: error.reason,
            }),
          )
        } else {
          sendFailure(port, toPublicIpcError(error, StreamChannel.readCodeWorkspaceFile))
        }
      }
      close()
    } finally {
      reading = false
    }
  }

  port.on("message", (message) => {
    const control = Schema.decodeUnknownOption(CodeWorkspaceFileStreamControl)(message.data)
    Option.match(control, {
      onNone: () => {
        sendFailure(
          port,
          toPublicIpcError(
            new Error("Invalid Code workspace file stream control message"),
            StreamChannel.readCodeWorkspaceFile,
          ),
        )
        cancel()
      },
      onSome: (value) =>
        CodeWorkspaceFileStreamControl.match(value, {
          Pull: () => void pull(),
          Cancel: cancel,
        }),
    })
  })
  port.on("close", () => {
    void iterator.return?.()
    closed = true
  })
  port.start()
}

const sendFailure = (port: MessagePortMain, error: TransportError) =>
  send(
    port,
    CodeWorkspaceFileStreamMessage.cases.Failure.make({
      error,
    }),
  )

const send = (port: MessagePortMain, message: CodeWorkspaceFileStreamMessage) => {
  const encoded = Schema.encodeUnknownSync(CodeWorkspaceFileStreamMessage)(message)
  assertJsonPayloadWithinBudget(
    encoded,
    CODE_WORKSPACE_FILE_STREAM_MESSAGE_BYTES,
    StreamChannel.readCodeWorkspaceFile,
  )
  port.postMessage(encoded)
}
