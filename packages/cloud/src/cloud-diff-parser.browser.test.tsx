import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { expect, it } from "vitest"
import { parseCloudUnifiedDiff, streamCloudUnifiedDiff } from "./cloud-diff-parser"

it("round-trips worker parsing with the same file and hunk identities as the domain parser", async () => {
  const patch =
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b.ts b/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+hello 🌎\n"
  expect(await parseCloudUnifiedDiff(patch)).toEqual(parseUnifiedDiff(patch))
  expect(await parseCloudUnifiedDiff("")).toEqual(parseUnifiedDiff(""))
})

it("keeps the browser event loop running during a many-file parse", async () => {
  const patch = Array.from(
    { length: 200 },
    (_, index) =>
      `diff --git a/file-${index}.ts b/file-${index}.ts\nnew file mode 100644\n--- /dev/null\n+++ b/file-${index}.ts\n@@ -0,0 +1,1000 @@\n${Array.from({ length: 1000 }, (_, line) => `+const value${line} = ${line}`).join("\n")}\n`,
  ).join("")
  let ticks = 0
  const timer = setInterval(() => {
    ticks += 1
  }, 0)
  try {
    const parsed = await parseCloudUnifiedDiff(patch)
    expect(parsed.files).toHaveLength(200)
    expect(ticks).toBeGreaterThan(5)
  } finally {
    clearInterval(timer)
  }
})

it("preserves UTF-8 and file boundaries across tiny network chunks", async () => {
  const patch =
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+🌎\ndiff --git a/b.ts b/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+second\n"
  const bytes = new TextEncoder().encode(patch)
  let offset = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + 7))
      offset = Math.min(bytes.length, offset + 7)
    },
  })
  const files = []
  for await (const file of streamCloudUnifiedDiff(new Response(body))) files.push(file)
  expect(files).toEqual(parseUnifiedDiff(patch).files)
})

it("cancels an unfinished response when the review is closed", async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  const controller = new AbortController()
  const files = streamCloudUnifiedDiff(new Response(body), controller.signal)
  const pending = files.next()
  controller.abort()
  await expect(pending).rejects.toMatchObject({ _tag: "CloudDiffParseError" })
  expect(cancelled).toBe(true)
})
