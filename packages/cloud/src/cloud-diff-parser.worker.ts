import { ParsedDiffFile } from "@diffdash/domain/diff"
import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { Schema } from "effect"

const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("chunk"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("finish") }),
  Schema.Null,
])
let buffer = ""
let finished = false
let headerFound = false
let scanOffset = 0

// Keep only the current file and a bounded transport chunk. Acknowledgements prevent
// parsed files from accumulating in the browser's structured-clone message queue.
globalThis.addEventListener("message", (event: MessageEvent<Schema.Json>) => {
  try {
    const command = Schema.decodeUnknownSync(Command)(event.data)
    if (command?.type === "chunk") buffer += command.text
    if (command?.type === "finish") finished = true
    const headers = /^diff --git a\/(.+) b\/(.+)$/gm
    if (!headerFound) {
      const first = headers.exec(buffer)
      if (first !== null) {
        buffer = buffer.slice(first.index)
        headerFound = true
        scanOffset = 1
      }
    }
    headers.lastIndex = scanOffset
    const next = headerFound ? headers.exec(buffer) : null
    if (headerFound && (next !== null || finished)) {
      const patch = buffer.slice(0, next === null ? buffer.length : next.index - 1)
      buffer = next === null ? "" : buffer.slice(next.index)
      headerFound = next !== null
      scanOffset = headerFound ? 1 : 0
      const file = parseUnifiedDiff(patch).files[0]
      if (file === undefined) throw new Error("Missing parsed file")
      globalThis.postMessage(
        { type: "file", file: Schema.encodeSync(ParsedDiffFile)(file) },
        { transfer: [] },
      )
    } else {
      scanOffset = Math.max(headerFound ? 1 : 0, buffer.lastIndexOf("\n") + 1)
      globalThis.postMessage({ type: finished ? "complete" : "ready" }, { transfer: [] })
    }
  } catch {
    buffer = ""
    globalThis.postMessage({ type: "failed" }, { transfer: [] })
  }
})
