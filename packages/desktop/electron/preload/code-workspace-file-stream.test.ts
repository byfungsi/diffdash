import { CodeWorkspaceFileReadResult, CodeWorkspaceLeaseId } from "@diffdash/domain/code-workspace"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  CODE_WORKSPACE_FILE_STREAM_MAX_BYTES,
  CodeWorkspaceFileStreamControl,
  CodeWorkspaceFileStreamMessage,
} from "@diffdash/protocol/code-workspace-stream"
import { InvokeChannel } from "@diffdash/protocol/channels"
import { bridgeResult, invokeResponseSchema } from "@diffdash/protocol/ipc"
import { Match, Schema } from "effect"
import { expect, it, vi } from "vitest"

import { readCodeWorkspaceFileStream } from "./code-workspace-file-stream"

it("assembles a pull-driven UTF-8 stream across chunk boundaries", async () => {
  const path = RepositoryRelativePath.make("src/large.ts")
  const content = `${"a".repeat(256 * 1_024 - 1)}😀tail`
  const bytes = new TextEncoder().encode(content)
  const chunks = [bytes.slice(0, 256 * 1_024), bytes.slice(256 * 1_024)]
  let pulls = 0

  const encoded = await readCodeWorkspaceFileStream(
    {
      postMessage: (_channel, _request, [port]) => {
        if (port === undefined) throw new Error("Expected a transferred stream port")
        port.onmessage = (event) => {
          const control = Schema.decodeUnknownSync(CodeWorkspaceFileStreamControl)(event.data)
          CodeWorkspaceFileStreamControl.match(control, {
            Cancel: () => port.close(),
            Pull: () => {
              const chunk = chunks[pulls]
              pulls += 1
              const message =
                chunk === undefined
                  ? CodeWorkspaceFileStreamMessage.cases.End.make({})
                  : CodeWorkspaceFileStreamMessage.cases.Chunk.make({ bytes: chunk })
              port.postMessage(Schema.encodeSync(CodeWorkspaceFileStreamMessage)(message))
            },
          })
        }
        port.start()
      },
    },
    { leaseId: CodeWorkspaceLeaseId.make("lease:large-file"), path },
  )

  const result = Schema.decodeUnknownSync(
    bridgeResult(invokeResponseSchema(InvokeChannel.readCodeWorkspaceFile)),
  )(encoded)
  expect(pulls).toBe(3)
  expect(
    Match.valueTags(result, {
      Failure: ({ error }) => error.message,
      Success: ({ value }) =>
        CodeWorkspaceFileReadResult.match(value, {
          content: (file) => file.content,
          rejected: ({ reason }) => reason,
        }),
    }),
  ).toBe(content)
})

it("cancels a stream that exceeds the aggregate file byte limit", async () => {
  const path = RepositoryRelativePath.make("src/oversized.ts")
  const chunk = new Uint8Array(256 * 1_024)
  let cancelled = false
  let pulls = 0

  const encoded = await readCodeWorkspaceFileStream(
    {
      postMessage: (_channel, _request, [port]) => {
        if (port === undefined) throw new Error("Expected a transferred stream port")
        port.addEventListener("message", (event) => {
          const control = Schema.decodeUnknownSync(CodeWorkspaceFileStreamControl)(event.data)
          CodeWorkspaceFileStreamControl.match(control, {
            Cancel: () => {
              cancelled = true
              port.close()
            },
            Pull: () => {
              pulls += 1
              port.postMessage(
                Schema.encodeSync(CodeWorkspaceFileStreamMessage)(
                  CodeWorkspaceFileStreamMessage.cases.Chunk.make({ bytes: chunk }),
                ),
              )
            },
          })
        })
        port.start()
      },
    },
    { leaseId: CodeWorkspaceLeaseId.make("lease:oversized-file"), path },
  )

  const result = Schema.decodeUnknownSync(
    bridgeResult(invokeResponseSchema(InvokeChannel.readCodeWorkspaceFile)),
  )(encoded)
  await vi.waitFor(() => expect(cancelled).toBe(true))
  expect(
    Match.valueTags(result, {
      Failure: ({ error }) => error.code,
      Success: () => "unexpected-success",
    }),
  ).toBe("PAYLOAD_TOO_LARGE")
  expect(pulls).toBe(CODE_WORKSPACE_FILE_STREAM_MAX_BYTES / chunk.byteLength + 1)
})

it("exposes cancellation to the renderer and forwards it to the stream port", async () => {
  const path = RepositoryRelativePath.make("src/cancelled.ts")
  let cancel = (): void => undefined
  let cancelled = false

  const running = readCodeWorkspaceFileStream(
    {
      postMessage: (_channel, _request, [port]) => {
        if (port === undefined) throw new Error("Expected a transferred stream port")
        port.addEventListener("message", (event) => {
          const control = Schema.decodeUnknownSync(CodeWorkspaceFileStreamControl)(event.data)
          CodeWorkspaceFileStreamControl.match(control, {
            Cancel: () => {
              cancelled = true
              port.close()
            },
            Pull: () => undefined,
          })
        })
        port.start()
      },
    },
    { leaseId: CodeWorkspaceLeaseId.make("lease:cancelled-file"), path },
    (current) => {
      cancel = current
    },
  )

  cancel()
  const result = Schema.decodeUnknownSync(
    bridgeResult(invokeResponseSchema(InvokeChannel.readCodeWorkspaceFile)),
  )(await running)
  await vi.waitFor(() => expect(cancelled).toBe(true))
  expect(
    Match.valueTags(result, {
      Failure: ({ error }) => error.code,
      Success: () => "unexpected-success",
    }),
  ).toBe("CANCELLED")
})
