import { ParsedDiff, ParsedDiffFile } from "@diffdash/domain/diff"
import { Schema } from "effect"

const ParserPublication = Schema.Union([
  Schema.Struct({ type: Schema.Literal("file"), file: ParsedDiffFile }),
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("complete") }),
  Schema.Struct({ type: Schema.Literal("failed") }),
])

/** Safe browser parser failure without patch content or repository paths. */
export class CloudDiffParseError extends Schema.TaggedError<CloudDiffParseError>()(
  "CloudDiffParseError",
  {
    message: Schema.String,
  },
) {}

/** Streams parsed files off-thread, with consumer backpressure and deterministic cleanup. */
export async function* streamCloudUnifiedDiff(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<ParsedDiffFile> {
  const reader = response.body?.getReader()
  if (reader === undefined)
    throw new CloudDiffParseError({ message: "The review diff has no body." })
  const worker = new Worker(new URL("./cloud-diff-parser.worker.ts", import.meta.url), {
    type: "module",
  })
  const decoder = new TextDecoder()
  const cancelRead = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal?.addEventListener("abort", cancelRead, { once: true })
  const exchange = (command: Schema.Json): Promise<typeof ParserPublication.Type> =>
    new Promise((resolve, reject) => {
      const cleanup = () => {
        worker.removeEventListener("message", receive)
        worker.removeEventListener("error", fail)
        worker.removeEventListener("messageerror", fail)
        signal?.removeEventListener("abort", fail)
      }
      const fail = () => {
        cleanup()
        reject(
          new CloudDiffParseError({ message: "The browser could not parse this review diff." }),
        )
      }
      const receive = (event: MessageEvent<Schema.Json>) => {
        try {
          const value = Schema.decodeUnknownSync(ParserPublication)(event.data)
          cleanup()
          resolve(value)
        } catch {
          fail()
        }
      }
      worker.addEventListener("message", receive)
      worker.addEventListener("error", fail)
      worker.addEventListener("messageerror", fail)
      signal?.addEventListener("abort", fail, { once: true })
      worker.postMessage(command, [])
    })
  try {
    let publication: typeof ParserPublication.Type = { type: "ready" }
    let end = false
    while (publication.type !== "complete") {
      if (signal?.aborted)
        throw new CloudDiffParseError({ message: "Review loading was cancelled." })
      if (publication.type === "failed")
        throw new CloudDiffParseError({ message: "The browser could not parse this review diff." })
      if (publication.type === "file") {
        yield publication.file
        publication = await exchange(null)
      } else if (end) {
        publication = await exchange({ type: "finish" })
      } else {
        const chunk = await reader.read()
        end = chunk.done
        publication = await exchange({
          type: "chunk",
          text: decoder.decode(chunk.value, { stream: !end }),
        })
      }
    }
  } finally {
    worker.terminate()
    signal?.removeEventListener("abort", cancelRead)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Collects a streamed worker parse for callers requiring a complete snapshot. */
export async function parseCloudUnifiedDiff(patch: string): Promise<ParsedDiff> {
  const files: ParsedDiffFile[] = []
  for await (const file of streamCloudUnifiedDiff(new Response(patch))) files.push(file)
  return new ParsedDiff({ files })
}
