import { describe, expect, it } from "@effect/vitest"
import { Match, Option } from "effect"
import { array, assert, integer, property } from "fast-check"

import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"

import {
  IncrementalUnifiedDiffParser,
  REVIEW_DIFF_MAX_BATCH_BYTES,
  REVIEW_DIFF_MAX_BATCH_ITEMS,
  type IncrementalDiffEvent,
} from "./incremental-diff-parser"
import { replayV1Identities } from "./v1-identity-replay"

const corpus = `preamble ignored
diff --git a/src/naive.ts b/src/naive.ts
index 1111111..2222222 100644
--- a/src/naive.ts
+++ b/src/naive.ts
@@ -1,2 +1,3 @@ function cafe()
-const label = "old"
+const label = "café 😃"
+const enabled = true
diff --git a/src/new.ts b/src/new.ts
new file mode 100755
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+new value
\\ No newline at end of file
diff --git a/src/old.ts b/src/new-name.ts
similarity index 80%
rename from src/old.ts
rename to src/new-name.ts
--- a/src/old.ts
+++ b/src/new-name.ts
@@ -10 +20 @@ section
-before
+after
diff --git a/assets/logo.png b/assets/logo.png
index 7777777..8888888 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`

const emptyHunkCorpus = `diff --git a/empty.txt b/empty.txt
--- a/empty.txt
+++ b/empty.txt
@@ -1,0 +1,0 @@
diff --git a/next.txt b/next.txt
--- a/next.txt
+++ b/next.txt
@@ -1 +1 @@
-old
+new
`

describe("IncrementalUnifiedDiffParser", () => {
  it("carries an added status beyond a provider's first hundred summary files", () => {
    const diff = Array.from({ length: 103 }, (_, index) => {
      const path = `src/file-${index + 1}.ts`
      return index === 102
        ? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+added\n`
        : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`
    }).join("")
    const parser = new IncrementalUnifiedDiffParser()
    const accepted = parser.accept(new TextEncoder().encode(diff))
    const finished = parser.finish()
    const started = [accepted, finished]
      .flatMap((result) =>
        Match.valueTags(result, { Failure: () => [], Success: ({ batches }) => batches }),
      )
      .flatMap(({ events }) => events)
      .filter((event) => event._tag === "FileStarted")

    expect(started).toHaveLength(103)
    expect(started[102]).toMatchObject({
      fileOrdinal: 102,
      gitNewPath: "src/file-103.ts",
      status: "added",
    })
  })

  it("does not synthesize an empty hunk line after a trailing newline", () => {
    const parser = new IncrementalUnifiedDiffParser()
    const accepted = parser.accept(
      new TextEncoder().encode(
        "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      ),
    )
    const finished = parser.finish()
    const parsedBatches = [accepted, finished].flatMap((result) =>
      Match.valueTags(result, { Failure: () => [], Success: ({ batches }) => batches }),
    )
    expect(parsedBatches.length).toBeGreaterThan(0)
    const parsedEvents = parsedBatches.flatMap(({ events: batchEvents }) => batchEvents)
    const lines = parsedEvents.flatMap((event) =>
      Match.valueTags(event, {
        FileStarted: () => [],
        FilePrelude: () => [],
        HunkStarted: () => [],
        HunkLine: ({ line }) => [line],
        HunkClosed: () => [],
        FileClosed: () => [],
      }),
    )
    const closedLineCounts = parsedEvents.flatMap((event) =>
      Match.valueTags(event, {
        FileStarted: () => [],
        FilePrelude: () => [],
        HunkStarted: () => [],
        HunkLine: () => [],
        HunkClosed: ({ lineCount }) => [lineCount],
        FileClosed: () => [],
      }),
    )
    expect(lines).toEqual(["-old", "+new"])
    expect(closedLineCounts).toEqual([2])
  })

  it("classifies complete Git binary patches at every byte split point", () => {
    const binary = `diff --git a/assets/logo.png b/assets/logo.png
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
GIT binary patch
literal 3
KcmZQzU|?Vb000000
`
    const bytes = new TextEncoder().encode(binary)
    for (let split = 1; split < bytes.byteLength; split += 1) {
      const statuses = parseChunks([bytes.slice(0, split), bytes.slice(split)]).flatMap((event) =>
        Match.valueTags(event, {
          FileStarted: () => [],
          FilePrelude: () => [],
          HunkStarted: () => [],
          HunkLine: () => [],
          HunkClosed: () => [],
          FileClosed: ({ file }) =>
            Option.match(Option.fromNullishOr(file), {
              onNone: () => [],
              onSome: (closed) => [closed.status],
            }),
        }),
      )
      expect(statuses).toEqual(["binary"])
    }
  })

  it("keeps complete binary payloads out of bounded file-prelude state", () => {
    const binary = `diff --git a/assets/logo.png b/assets/logo.png
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
GIT binary patch
${`${"A".repeat(64)}\n`.repeat(3_000)}`
    const bytes = new TextEncoder().encode(binary)
    const chunks: Uint8Array[] = []
    for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024)
      chunks.push(bytes.slice(offset, offset + 64 * 1024))
    const events = parseChunks(chunks)
    const preludeLines = events.flatMap((event) =>
      Match.valueTags(event, {
        FileStarted: () => [],
        FilePrelude: ({ lines }) => [lines],
        HunkStarted: () => [],
        HunkLine: () => [],
        HunkClosed: () => [],
        FileClosed: () => [],
      }),
    )
    const statuses = events.flatMap((event) =>
      Match.valueTags(event, {
        FileStarted: () => [],
        FilePrelude: () => [],
        HunkStarted: () => [],
        HunkLine: () => [],
        HunkClosed: () => [],
        FileClosed: ({ file }) =>
          Option.match(Option.fromNullishOr(file), {
            onNone: () => [],
            onSome: (closed) => [closed.status],
          }),
      }),
    )

    expect(preludeLines).toEqual([
      [
        "diff --git a/assets/logo.png b/assets/logo.png",
        "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644",
        "GIT binary patch",
      ],
    ])
    expect(statuses).toEqual(["binary"])
  })

  it("matches the v1 semantic corpus and identities at every byte split point", () => {
    const bytes = new TextEncoder().encode(corpus)
    const expected = parseUnifiedDiff(corpus)
    const baseline = parseChunks([bytes])

    for (let split = 1; split < bytes.byteLength; split += 1) {
      const actual = parseChunks([bytes.slice(0, split), bytes.slice(split)])
      expect(actual).toEqual(baseline)
    }

    const closedFiles = baseline.flatMap((event) =>
      Match.valueTags(event, {
        FileStarted: () => [],
        FilePrelude: () => [],
        HunkStarted: () => [],
        HunkLine: () => [],
        HunkClosed: () => [],
        FileClosed: ({ file }) => (file === null ? [] : [file]),
      }),
    )
    expect(closedFiles).toHaveLength(expected.files.length)
    for (const [index, closed] of closedFiles.entries()) {
      const expectedFile = expected.files[index]
      expect(expectedFile).toBeDefined()
      const identities = replayV1Identities(closed, baseline)
      const hunkEvents = baseline.flatMap((event) =>
        Match.valueTags(event, {
          FileStarted: () => [],
          FilePrelude: () => [],
          HunkStarted: () => [],
          HunkLine: () => [],
          HunkClosed: (hunk) => (hunk.fileOrdinal === closed.ordinal ? [hunk] : []),
          FileClosed: () => [],
        }),
      )
      expect(closed).toMatchObject({
        additions: expectedFile?.additions,
        deletions: expectedFile?.deletions,
        fileId: expectedFile?.fileId,
        oldPath: expectedFile?.oldPath,
        path: expectedFile?.path,
        status: expectedFile?.status,
      })
      expect(identities.patchHash).toBe(expectedFile?.patchHash)
      expect(identities.hunkIds).toEqual(expectedFile?.hunks.map((hunk) => hunk.id))
      expect(hunkEvents.map((event) => event.id)).toEqual(
        expectedFile?.hunks.map((hunk) => hunk.id),
      )
      expect(hunkEvents.map((event) => event.fingerprint)).toEqual(
        expectedFile?.hunks.map((hunk) => hunk.fingerprint),
      )
    }
  })

  it("is independent of generated chunk partitions including UTF-8 continuation splits", () => {
    const bytes = new TextEncoder().encode(corpus)
    const baseline = parseChunks([bytes])
    assert(
      property(array(integer({ min: 1, max: 97 }), { minLength: 1, maxLength: 80 }), (sizes) => {
        const chunks: Uint8Array[] = []
        let offset = 0
        for (const size of sizes) {
          if (offset >= bytes.byteLength) break
          chunks.push(bytes.slice(offset, offset + size))
          offset += size
        }
        if (offset < bytes.byteLength) chunks.push(bytes.slice(offset))
        expect(parseChunks(chunks)).toEqual(baseline)
      }),
      { numRuns: 200, seed: 233 },
    )
  })

  it("replays the existing v1 identity for a hunk with no normalized content", () => {
    const expected = parseUnifiedDiff(emptyHunkCorpus)
    const events = parseChunks([new TextEncoder().encode(emptyHunkCorpus)])
    const closed = Option.fromNullishOr(
      events
        .flatMap((event) =>
          Match.valueTags(event, {
            FileStarted: () => [],
            FilePrelude: () => [],
            HunkStarted: () => [],
            HunkLine: () => [],
            HunkClosed: () => [],
            FileClosed: ({ file }) => (file?.path === "empty.txt" ? [file] : []),
          }),
        )
        .at(0),
    )
    expect(Option.map(closed, (file) => replayV1Identities(file, events).hunkIds)).toEqual(
      Option.fromNullishOr(expected.files[0]?.hunks.map(({ id }) => id)),
    )
  })

  it("rejects file prelude retention above its fixed parser-state limit", () => {
    const path = "x".repeat(200 * 1024)
    const metadata = "old mode 100644\n".repeat(7_500)
    const diff = `diff --git a/a b/b\nrename from ${path}\nrename to ${path}\n${metadata}`
    const parser = new IncrementalUnifiedDiffParser()
    const bytes = new TextEncoder().encode(diff)
    let result = parser.accept(bytes.slice(0, 1024))
    for (
      let offset = 1024;
      offset < bytes.byteLength &&
      Match.valueTags(result, { Failure: () => false, Success: () => true });
      offset += 1024
    )
      result = parser.accept(bytes.slice(offset, offset + 1024))
    expect(result).toMatchObject({
      _tag: "Failure",
      error: { reason: "parserStateTooLarge" },
    })
  })

  it("emits bounded batches and rejects a line above the explicit 256 KiB limit", () => {
    const parser = new IncrementalUnifiedDiffParser()
    const diff = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n+${"x".repeat(256 * 1024 + 1)}`
    const bytes = new TextEncoder().encode(diff)
    let failureReason: string | null = null
    for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
      const result = parser.accept(bytes.slice(offset, offset + 64 * 1024))
      const failed = Match.valueTags(result, {
        Failure: ({ error }) => {
          failureReason = error.reason
          return true
        },
        Success: () => false,
      })
      if (failed) break
      const acceptedBatches = Match.valueTags(result, {
        Failure: () => [],
        Success: ({ batches }) => batches,
      })
      for (const batch of acceptedBatches) {
        expect(batch.events.length).toBeLessThanOrEqual(REVIEW_DIFF_MAX_BATCH_ITEMS)
        expect(batch.byteCount).toBeLessThanOrEqual(REVIEW_DIFF_MAX_BATCH_BYTES)
      }
    }
    expect(failureReason).toBe("lineTooLarge")
  })
})

const parseChunks = (chunks: ReadonlyArray<Uint8Array>): ReadonlyArray<IncrementalDiffEvent> => {
  const parser = new IncrementalUnifiedDiffParser()
  const events: IncrementalDiffEvent[] = []
  for (const chunk of chunks) {
    const result = parser.accept(chunk)
    Match.valueTags(result, {
      Failure: ({ error }) => {
        throw error
      },
      Success: ({ batches }) => {
        for (const batch of batches) events.push(...batch.events)
      },
    })
  }
  const result = parser.finish()
  Match.valueTags(result, {
    Failure: ({ error }) => {
      throw error
    },
    Success: ({ batches }) => {
      for (const batch of batches) events.push(...batch.events)
    },
  })
  return events
}
