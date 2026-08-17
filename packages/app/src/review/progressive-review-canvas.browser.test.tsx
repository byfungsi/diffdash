import { parseUnifiedDiff } from "@diffdash/domain/diff-parser"
import { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import { ReviewKey, ReviewProjectId, ReviewSnapshotId } from "@diffdash/domain/review-identity"
import {
  ReviewSessionId,
  ReviewSessionIdentity,
  ReviewSessionProcessId,
  ReviewSessionStateVersion,
  type ReviewSessionRange,
} from "@diffdash/protocol/review-session"
import { type ReactNode, useRef } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ProgressiveReviewCanvas } from "./progressive-review-canvas"
import { DiffVirtualizer } from "./pierre"
import type {
  ProgressiveReviewContentProjection,
  ProgressiveReviewContentReader,
} from "./progressive-review-content-session"

const identity = ReviewSessionIdentity.make({
  projectId: ReviewProjectId.make("project-canvas"),
  reviewKey: ReviewKey.make("review-canvas"),
  snapshotId: ReviewSnapshotId.make("snapshot:v1:cccccccccccccccccccccccccccccccc"),
  processId: ReviewSessionProcessId.make("process-canvas"),
  sessionId: ReviewSessionId.make("session-canvas"),
  stateVersion: ReviewSessionStateVersion.make(1),
})

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

describe("ProgressiveReviewCanvas", () => {
  it("keeps a 1k-file production inventory to one bounded global mount window", async () => {
    const files = Array.from({ length: 1_024 }, (_, index) => inventoryFile(index))
    const reader = makeReader(files, async (file, startLine) => range(file, startLine, true))
    render(<CanvasHarness files={files} reader={reader} />)

    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-review-file-id]").length).toBeGreaterThan(0),
    )
    await vi.waitFor(() =>
      expect(document.querySelector("diffs-container")?.shadowRoot).not.toBeNull(),
    )
    const mountedCards = document.querySelectorAll("[data-review-file-id]").length
    const mountedRows = Number(
      document
        .querySelector("[data-review-global-canvas]")
        ?.getAttribute("data-review-mounted-rows"),
    )
    expect(mountedCards).toBeLessThan(100)
    expect(mountedRows).toBeLessThanOrEqual(1_000)
    expect(document.querySelectorAll("[data-review-page-placeholder-file-id]")).toHaveLength(0)
  })

  it("replaces a multi-megabyte file with successive legal bounded ranges", async () => {
    const file = inventoryFile(0, 150_000)
    const starts: number[] = []
    const reader = makeReader([file], async (requested, startLine) => {
      starts.push(startLine)
      return range(requested, startLine, startLine >= 2)
    })
    render(<CanvasHarness files={[file]} reader={reader} />)

    await vi.waitFor(() => expect(starts).toEqual([0]))
    await vi.waitFor(() =>
      expect(document.querySelector("diffs-container")?.shadowRoot).not.toBeNull(),
    )
    const next = await vi.waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>("[data-progressive-next-range]")
      expect(button).not.toBeNull()
      return button
    })
    next?.click()

    await vi.waitFor(() => expect(starts).toEqual([0, 2]))
    expect(document.querySelectorAll("[data-progressive-range-host]")).toHaveLength(1)
    expect(
      document
        .querySelector("[data-progressive-range-start]")
        ?.getAttribute("data-progressive-range-start"),
    ).toBe("2")
  })
})

const CanvasHarness = ({
  files,
  reader,
}: {
  readonly files: readonly ReviewSnapshotFileInventory[]
  readonly reader: ProgressiveReviewContentReader
}) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={scrollRef} style={{ height: 600, overflowY: "auto" }}>
      <ProgressiveReviewCanvas
        diffVirtualizer={new DiffVirtualizer({})}
        files={files}
        expandedFileKeys={new Set(files.map((file) => file.reviewKey))}
        expandedLineAnchor={null}
        forceExpandedFileKeys={new Set()}
        identity={identity}
        mode="unified"
        navigationActive={false}
        navigationSeekGeneration={0}
        navigationTargetFileId={null}
        navigationRangeTarget={null}
        options={{ disableFileHeader: true, overflow: "wrap" }}
        priorityFileId={null}
        reader={reader}
        reviewThreads={{
          details: [],
          error: null,
          loading: false,
          available: true,
          createThread: async () => undefined,
          addUserMessage: async () => undefined,
          runAgent: async () => undefined,
          runningThreadIds: [],
          agentProgress: [],
          agentErrors: {},
          refreshThread: async () => undefined,
          reload: async () => undefined,
        }}
        scrollContainerRef={scrollRef}
        selectedPath={files[0]?.path ?? null}
        viewedFileKeys={new Set()}
        onFileAnchorChange={() => () => undefined}
        onDiffRendered={() => undefined}
        onOpenFile={() => undefined}
        onOpenThread={() => undefined}
        onSelect={() => undefined}
        onSetViewed={() => undefined}
        onToggleExpanded={() => undefined}
        onToggleLine={() => undefined}
      />
    </div>
  )
}

const inventoryFile = (index: number, additions = 1): ReviewSnapshotFileInventory => {
  const parsed = parseUnifiedDiff(`diff --git a/src/file-${index}.ts b/src/file-${index}.ts
--- a/src/file-${index}.ts
+++ b/src/file-${index}.ts
@@ -1 +1 @@
-old
+new`).files[0]
  if (parsed === undefined) throw new Error("Missing canvas fixture file")
  return ReviewSnapshotFileInventory.make({
    fileId: parsed.fileId,
    patchHash: parsed.patchHash,
    reviewKey: parsed.reviewKey,
    path: parsed.path,
    oldPath: parsed.oldPath,
    status: parsed.status,
    visibility: parsed.visibility,
    additions,
    deletions: parsed.deletions,
    hunkCount: parsed.hunks.length,
  })
}

const makeReader = (
  files: readonly ReviewSnapshotFileInventory[],
  read: (file: ReviewSnapshotFileInventory, startLine: number) => Promise<ReviewSessionRange>,
): ProgressiveReviewContentReader => {
  const projection: ProgressiveReviewContentProjection = {
    projectId: identity.projectId,
    snapshotId: identity.snapshotId,
    identity,
    inventory: files,
    inventoryLoading: false,
    inventoryError: null,
    files: [],
    loadingFileIds: new Set(),
    fileErrors: new Map(),
    snapshotRefresh: { _tag: "idle" },
  }
  return {
    getFile: () => null,
    getProjection: () => projection,
    loadFiles: async () => ({
      snapshotId: identity.snapshotId,
      statuses: new Map(),
      failureCauses: new Map(),
    }),
    readRange: async ({ fileId, startLine }) => {
      const file = files.find((candidate) => candidate.fileId === fileId)
      if (file === undefined) throw new Error("Unknown fixture file")
      return read(file, startLine)
    },
    resolveTarget: async () => {
      throw new Error("Unused by canvas fixture")
    },
    waitForManifestReplacement: async () => identity.snapshotId,
  }
}

const range = (
  file: ReviewSnapshotFileInventory,
  startLine: number,
  complete: boolean,
): ReviewSessionRange => {
  const content = startLine === 0 ? "@@ -1 +1 @@\n-old\n+new\n" : "@@ -20 +20 @@\n-before\n+after\n"
  const bytes = new TextEncoder().encode(content)
  return {
    identity,
    file: { ...file, ordinal: 0 },
    blocks: [
      {
        id: `block-${startLine}`,
        hunkId: null,
        ordinal: startLine === 0 ? 0 : 1,
        firstLine: startLine,
        lineCount: 2,
        bytes,
      },
    ],
    byteCount: bytes.byteLength,
    complete,
  }
}

const render = (node: ReactNode): void => {
  const container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  flushSync(() => root?.render(node))
}
