import { IncrementalUnifiedDiffParser } from "./incremental-diff-parser"
import { Match } from "effect"
import type { ReviewDataWorkerCommand, ReviewDataWorkerResponse } from "./worker-runtime"

/** Minimal message endpoint implemented by Node parent ports, Bun workers, and test harnesses. */
export interface ReviewDataWorkerEndpoint {
  /** Receives commands from the owning review session. */
  onCommand(listener: (command: ReviewDataWorkerCommand) => void): () => void
  /** Emits one bounded or terminal response to the owning review session. */
  respond(response: ReviewDataWorkerResponse): void
  /** Closes the endpoint after cancellation. */
  close(): void
}

/** Pre-authorized staging capability that exposes neither a path nor an operation for opening files. */
export interface ReviewDataWorkerStaging {
  /** Appends one source-validated byte chunk before parser acknowledgement. */
  append(bytes: Uint8Array): Promise<void>
  /** Idempotently flushes and closes the staging capability. */
  close(): Promise<void>
}

/**
 * Attaches the parser to an isolated worker endpoint. The endpoint intentionally receives no
 * SQLite capability, product database path, or ambient service container.
 */
export const attachReviewDataWorker = (
  endpoint: ReviewDataWorkerEndpoint,
  staging: ReviewDataWorkerStaging,
): (() => void) => {
  const parser = new IncrementalUnifiedDiffParser()
  let closed = false
  let parsing = Promise.resolve()
  const unsubscribe = endpoint.onCommand((command) => {
    if (closed) return
    Match.value(command).pipe(
      Match.tag("Heartbeat", ({ requestId }) => endpoint.respond({ _tag: "Heartbeat", requestId })),
      Match.tag("Cancel", ({ requestId }) => {
        closed = true
        endpoint.respond({ _tag: "Cancelled", requestId })
        unsubscribe()
        void staging.close().catch(() => undefined)
        endpoint.close()
      }),
      Match.tagsExhaustive({
        Chunk: ({ bytes, requestId }) => {
          parsing = parsing
            .then(async () => {
              await staging.append(bytes)
              if (!closed) publishParseResult(requestId, "Accepted", parser.accept(bytes), endpoint)
              return undefined
            })
            .catch(() => {
              if (closed) return
              closed = true
              endpoint.respond({
                _tag: "Failed",
                requestId,
                message: "Review data worker staging failed while appending bytes",
              })
              unsubscribe()
              endpoint.close()
            })
        },
        Finish: ({ requestId }) => {
          parsing = parsing
            .then(async () => {
              const result = parser.finish()
              await staging.close()
              if (!closed) publishParseResult(requestId, "Finished", result, endpoint)
              return undefined
            })
            .catch(() => {
              if (closed) return
              closed = true
              endpoint.respond({
                _tag: "Failed",
                requestId,
                message: "Review data worker staging failed while closing",
              })
              unsubscribe()
              endpoint.close()
            })
        },
      }),
    )
  })
  return () => {
    if (closed) return
    closed = true
    unsubscribe()
    void staging.close().catch(() => undefined)
    endpoint.close()
  }
}

const publishParseResult = (
  requestId: number,
  successTag: "Accepted" | "Finished",
  result: ReturnType<IncrementalUnifiedDiffParser["finish"]>,
  endpoint: ReviewDataWorkerEndpoint,
): void => {
  Match.value(result).pipe(
    Match.tag("Failure", ({ error }) =>
      endpoint.respond({ _tag: "Failed", requestId, message: error.message }),
    ),
    Match.tag("Success", ({ batches }) => {
      for (const batch of batches) endpoint.respond({ _tag: "Batch", requestId, batch })
      endpoint.respond(
        successTag === "Accepted"
          ? { _tag: "Accepted", requestId }
          : { _tag: "Finished", requestId },
      )
    }),
    Match.exhaustive,
  )
}
