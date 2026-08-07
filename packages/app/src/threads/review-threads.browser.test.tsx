import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import {
  LineReviewAnchor,
  MarkdownBody,
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadMessage,
  ReviewThreadMessageId,
} from "@diffdash/domain/review-thread"
import type { ReactNode } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ReviewThreadListPane } from "./review-thread-sidebar"
import {
  ReviewMarkdown,
  ReviewThreadComposer,
  type ReviewThreadOrchestration,
  ReviewThreadPanel,
  type ReviewThreadsController,
  reviewLineLabel,
} from "./review-threads"

let root: Root | null = null

const lineAnchor = LineReviewAnchor.make({
  fileId: ReviewFileId.make("file-browser"),
  filePath: "src/example.ts",
  oldPath: null,
  hunkId: ReviewHunkId.make("hunk-browser"),
  hunkFingerprint: ReviewHunkFingerprint.make("fingerprint-browser"),
  hunkHeader: "@@ -7 +7 @@",
  side: "new",
  lineNumber: 7,
  lineContent: "const example = true",
})

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

describe("review thread UI", () => {
  it("submits an accessible line-comment composer without cancelling the line", async () => {
    const onSubmit = vi.fn<(bodyMarkdown: string) => Promise<void>>(async () => undefined)
    const onCancel = vi.fn<() => void>()
    render(<ReviewThreadComposer label="Line comment" onCancel={onCancel} onSubmit={onSubmit} />)

    await vi.waitFor(() => expect(document.querySelector("textarea")).not.toBeNull())
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Thread message"]',
    )
    expect(textarea).not.toBeNull()
    expect(document.activeElement).toBe(textarea)
    setTextareaValue(textarea!, "**Check** this path")
    textarea!.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        metaKey: true,
      }),
    )

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
    expect(onSubmit.mock.calls[0]?.[0]).toBe("**Check** this path")
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("renders Markdown and distinct persisted agent lifecycle states", async () => {
    const details = threadDetails()
    const retryAgentMessage = vi.fn<ReviewThreadOrchestration["retryAgentMessage"]>(
      async () => undefined,
    )
    const onRefresh = threadActionMock()
    const orchestration: ReviewThreadOrchestration = { retryAgentMessage }
    render(
      <ReviewThreadPanel
        agentRunning={false}
        details={details}
        orchestration={orchestration}
        onAddUserMessage={threadMessageActionMock()}
        onRefresh={onRefresh}
      />,
    )

    expect(document.querySelector('[aria-label="User message"] strong')?.textContent).toBe("Check")
    expect(document.querySelector('[aria-label="User message"] code')?.textContent).toBe("value")
    expect(document.querySelectorAll('[aria-label="Agent message"]')).toHaveLength(2)
    expect(document.body.textContent).not.toContain("Local · not on GitHub")
    expect(document.body.textContent).not.toContain("src/example.ts:7")
    expect(document.body.textContent).not.toContain("Current revision")
    expect(document.querySelector("output")?.textContent).toContain("Preparing review context...")
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Agent response failed")

    expect(document.querySelector('[aria-label="Reply to this line comment"]')).toBeNull()
    const retry = [...document.querySelectorAll("button")].find(
      (button) =>
        button.textContent === "Retry" && button.closest('[aria-label="Agent message"]') !== null,
    )
    retry?.click()
    await vi.waitFor(() => expect(retryAgentMessage).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledWith(details.thread.id))
    expect(document.querySelector("button")?.textContent).not.toContain("Close")
  })

  it("labels revision context", () => {
    const details = threadDetails({ previousRevision: true })
    render(
      <ReviewThreadPanel
        agentRunning={false}
        details={details}
        onAddUserMessage={threadMessageActionMock()}
        onRefresh={threadActionMock()}
      />,
    )

    expect(document.body.textContent).toContain("Previous revision")
  })

  it("labels inline reviews by diff side and line instead of internal hunk identity", () => {
    expect(reviewLineLabel(lineAnchor)).toBe("R7")
    expect(reviewLineLabel(LineReviewAnchor.make({ ...lineAnchor, side: "old" }))).toBe("L7")
  })

  it("sends a follow-up after the agent response completes", async () => {
    const details = threadDetails({ pending: false })
    const onAddUserMessage = threadMessageActionMock()
    render(
      <ReviewThreadPanel
        agentRunning={false}
        details={details}
        onAddUserMessage={onAddUserMessage}
        onRefresh={threadActionMock()}
      />,
    )

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Thread message"]',
    )
    expect(textarea).not.toBeNull()
    setTextareaValue(textarea!, "Can you explain the edge case?")
    buttonNamed("Send").click()
    await vi.waitFor(() =>
      expect(onAddUserMessage).toHaveBeenCalledWith(
        details.thread.id,
        "Can you explain the edge case?",
      ),
    )
    expect(document.body.textContent).not.toContain("Close")
  })

  it("shows progress without a false failure before the pending message is refreshed", () => {
    render(
      <ReviewThreadPanel
        agentRunning
        agentProgress="creating-repository"
        details={userOnlyThreadDetails()}
        orchestration={{ retryAgentMessage: async () => undefined }}
        onAddUserMessage={threadMessageActionMock()}
        onRefresh={threadActionMock()}
      />,
    )

    expect(document.querySelector("output")?.textContent).toContain(
      "Creating isolated repository...",
    )
    expect(document.body.textContent).not.toContain("Codex")
    expect(document.body.textContent).not.toContain("Claude")
    expect(document.body.textContent).not.toContain("OpenCode")
    expect(document.body.textContent).not.toContain("The agent response did not start")
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(buttonsNamed("Retry")).toHaveLength(0)
    expect(document.querySelector('textarea[aria-label="Thread message"]')).toBeNull()
  })

  it("shows a thread-local orchestration failure with a working retry", async () => {
    const details = userOnlyThreadDetails()
    const retryAgentMessage = vi.fn<ReviewThreadOrchestration["retryAgentMessage"]>(
      async () => undefined,
    )
    render(
      <ReviewThreadPanel
        agentRunning={false}
        agentError="No review agent provider is available"
        details={details}
        orchestration={{ retryAgentMessage }}
        onAddUserMessage={threadMessageActionMock()}
        onRefresh={threadActionMock()}
      />,
    )

    expect(document.body.textContent).toContain("No review agent provider is available")
    const localRetry = [...document.querySelectorAll<HTMLButtonElement>("button")].at(-1)
    expect(localRetry?.textContent).toBe("Retry")
    localRetry?.click()
    await vi.waitFor(() =>
      expect(retryAgentMessage).toHaveBeenCalledWith(
        details.thread.id,
        details.messages.at(-1)?.id,
      ),
    )
  })

  it("recovers a persisted user-only turn instead of offering another follow-up", async () => {
    const details = userOnlyThreadDetails()
    const retryAgentMessage = vi.fn<ReviewThreadOrchestration["retryAgentMessage"]>(
      async () => undefined,
    )
    render(
      <ReviewThreadPanel
        agentRunning={false}
        details={details}
        orchestration={{ retryAgentMessage }}
        onAddUserMessage={threadMessageActionMock()}
        onRefresh={threadActionMock()}
      />,
    )

    expect(document.body.textContent).toContain("The agent response did not start")
    expect(document.querySelector('textarea[aria-label="Thread message"]')).toBeNull()
    buttonNamed("Retry").click()
    await vi.waitFor(() =>
      expect(retryAgentMessage).toHaveBeenCalledWith(details.thread.id, details.messages[0]?.id),
    )
  })

  it("shows a new retry error even when the previous response already failed", () => {
    render(
      <ReviewThreadPanel
        agentRunning={false}
        agentError="The review snapshot could not be refreshed"
        details={threadDetails({ pending: false })}
        orchestration={{ retryAgentMessage: async () => undefined }}
        onAddUserMessage={threadMessageActionMock()}
        onRefresh={threadActionMock()}
      />,
    )

    expect(document.body.textContent).toContain("The review snapshot could not be refreshed")
  })

  it("updates the pending agent message to the latest preparation stage", () => {
    const panel = (agentProgress: "fetching-review-revision" | "checking-out-revision") => (
      <ReviewThreadPanel
        agentRunning
        agentProgress={agentProgress}
        details={threadDetails()}
        onAddUserMessage={threadMessageActionMock()}
        onRefresh={threadActionMock()}
      />
    )
    render(panel("fetching-review-revision"))
    expect(document.querySelector("output")?.textContent).toContain(
      "Fetching latest review revision...",
    )

    flushSync(() => root?.render(panel("checking-out-revision")))
    expect(document.querySelector("output")?.textContent).toContain(
      "Checking out and verifying review revision...",
    )
  })

  it("keeps conversation updates pinned only while the reader remains near the bottom", async () => {
    const initial = threadDetails({ pending: false })
    const panel = (details: ReviewThreadDetails) => (
      <ReviewThreadPanel
        agentRunning={false}
        details={details}
        onAddUserMessage={threadMessageActionMock()}
        onRefresh={threadActionMock()}
      />
    )
    render(panel(initial))
    const history = document.querySelector<HTMLElement>('[role="log"]')
    expect(history).not.toBeNull()
    if (history === null) return
    expect(history.getAttribute("aria-label")).toContain("conversation history")
    expect(history.tabIndex).toBe(0)
    Object.defineProperties(history, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 700, writable: true },
    })
    history.dispatchEvent(new Event("scroll", { bubbles: true }))

    const whileReading = appendMessage(initial, "message-new-user", "user")
    flushSync(() => root?.render(panel(whileReading)))
    await nextAnimationFrame()
    expect(history.scrollTop).toBe(700)

    history.scrollTop = 760
    history.dispatchEvent(new Event("scroll", { bubbles: true }))
    const whilePinned = appendMessage(whileReading, "message-new-agent", "agent")
    flushSync(() => root?.render(panel(whilePinned)))
    await nextAnimationFrame()
    expect(history.scrollTop).toBe(1_000)
  })

  it("shows sidebar loading, count, and retryable load errors", async () => {
    const reload = vi.fn<() => Promise<void>>(async () => undefined)
    const buttonRefs = { current: new Map<ReviewThreadId, HTMLButtonElement>() }
    const sidebar = (loading: boolean, error: string | null) => (
      <ReviewThreadListPane
        buttonRefs={buttonRefs}
        controller={threadController({
          details: [threadDetails({ pending: false })],
          error,
          loading,
          reload,
        })}
        navigableThreadIds={new Set()}
        state={{ _tag: "list" }}
        onCollapse={() => undefined}
        onGoToDiff={() => undefined}
        onOpenDetail={() => undefined}
      />
    )
    render(sidebar(true, null))
    expect(document.body.textContent).toContain("1 thread")
    expect(document.querySelector("output")?.textContent).toContain("Loading")

    flushSync(() => root?.render(sidebar(false, "Could not load review threads")))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not load review threads",
    )
    buttonNamed("Retry").click()
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
  })

  it("renders semantic Markdown blocks without injecting HTML", () => {
    render(
      <div data-testid="markdown-under-test">
        <ReviewMarkdown>{`# Finding

- first
- second

\`\`\`ts
const safe = true
\`\`\`

<script>unsafe()</script>`}</ReviewMarkdown>
      </div>,
    )

    expect(document.querySelector("h3")?.textContent).toBe("Finding")
    expect(document.querySelectorAll("li")).toHaveLength(2)
    expect(document.querySelector("pre code")?.textContent).toContain("const safe = true")
    expect(document.querySelector('[data-testid="markdown-under-test"] script')).toBeNull()
    expect(document.body.textContent).toContain("<script>unsafe()</script>")
  })

  it("keeps shorter backtick fences inside longer code fences", () => {
    render(
      <ReviewMarkdown>{`\`\`\`\`md
\`\`\`ts
const nested = true
\`\`\`
\`\`\`\``}</ReviewMarkdown>,
    )

    expect(document.querySelector("pre code")?.textContent).toContain("```ts")
    expect(document.querySelector("pre code")?.textContent).toContain("const nested = true")
  })

  it("repairs escaped structure and distinguishes technical references", () => {
    render(
      <div data-testid="markdown-under-test">
        <ReviewMarkdown>
          {
            "CoreConfiguration changed.\\n- Read packages/core/src/core-configuration.ts:4, README.md, and LICENSE\\n- Trace createCoreLayer through paths.settings in packages/app/src and .github/workflows/ci.yml.\\n\\nCompare `packages/app/src/app.tsx:12` with `AppSettings`. Use ``value\\nafter`` for a literal newline escape."
          }
        </ReviewMarkdown>
      </div>,
    )

    expect(document.querySelectorAll("li")).toHaveLength(2)
    expect(document.body.textContent).not.toContain("changed.\\n-")
    expect(document.body.textContent).toContain("Use value\\nafter for a literal newline escape.")
    expect(document.body.textContent).not.toContain("``value")
    expect(
      [...document.querySelectorAll('[data-review-file-reference="true"]')].map(
        (element) => element.textContent,
      ),
    ).toEqual(
      expect.arrayContaining([
        "packages/core/src/core-configuration.ts:4",
        "packages/app/src/app.tsx:12",
        "packages/app/src",
        "README.md",
        "LICENSE",
        ".github/workflows/ci.yml",
      ]),
    )
    expect(
      [...document.querySelectorAll('[data-review-symbol-reference="true"]')].map(
        (element) => element.textContent,
      ),
    ).toEqual(
      expect.arrayContaining([
        "CoreConfiguration",
        "createCoreLayer",
        "paths.settings",
        "AppSettings",
      ]),
    )
  })
})

const threadDetails = ({ previousRevision = false, pending = true } = {}) => {
  const threadId = ReviewThreadId.make("thread-1")
  const currentRevision = ReviewRevision.make("head-current")
  const originalRevision = ReviewRevision.make(previousRevision ? "head-previous" : "head-current")
  return ReviewThreadDetails.make({
    thread: ReviewThread.make({
      id: threadId,
      repoId: "repo-1",
      reviewKey: ReviewKey.make("github:fungsi/diffdash#65"),
      prNumber: 65,
      baseRevision: ReviewRevision.make("base-previous"),
      headRevision: originalRevision,
      currentBaseRevision: ReviewRevision.make("base-current"),
      currentHeadRevision: currentRevision,
      originalAnchor: lineAnchor,
      currentAnchor: lineAnchor,
      anchorStatus: "active",
      createdAt: "2026-07-12T09:00:00Z",
      updatedAt: "2026-07-12T09:01:00Z",
    }),
    messages: [
      ReviewThreadMessage.make({
        id: ReviewThreadMessageId.make("message-user"),
        threadId,
        sequence: 1,
        author: "user",
        bodyMarkdown: MarkdownBody.make("**Check** the `value`."),
        status: "complete",
        agentRunId: null,
        createdAt: "2026-07-12T09:00:00Z",
        updatedAt: "2026-07-12T09:00:00Z",
      }),
      ...(pending
        ? [
            ReviewThreadMessage.make({
              id: ReviewThreadMessageId.make("message-pending"),
              threadId,
              sequence: 2,
              author: "agent",
              bodyMarkdown: MarkdownBody.make("Looking at the call path..."),
              status: "pending",
              agentRunId: "run-1",
              createdAt: "2026-07-12T09:00:10Z",
              updatedAt: "2026-07-12T09:00:10Z",
            }),
          ]
        : [
            ReviewThreadMessage.make({
              id: ReviewThreadMessageId.make("message-complete"),
              threadId,
              sequence: 2,
              author: "agent",
              bodyMarkdown: MarkdownBody.make("The edge case is covered."),
              status: "complete",
              agentRunId: "run-1",
              createdAt: "2026-07-12T09:00:10Z",
              updatedAt: "2026-07-12T09:00:10Z",
            }),
          ]),
      ReviewThreadMessage.make({
        id: ReviewThreadMessageId.make("message-failed"),
        threadId,
        sequence: 3,
        author: "agent",
        bodyMarkdown: MarkdownBody.make(""),
        status: "failed",
        agentRunId: "run-2",
        createdAt: "2026-07-12T09:01:00Z",
        updatedAt: "2026-07-12T09:01:00Z",
      }),
    ],
  })
}

const userOnlyThreadDetails = () => {
  const populated = threadDetails({ pending: false })
  const initialMessage = populated.messages[0]
  if (initialMessage === undefined) throw new Error("Expected an initial user message")
  return ReviewThreadDetails.make({
    thread: populated.thread,
    messages: [initialMessage],
  })
}

const appendMessage = (details: ReviewThreadDetails, id: string, author: "agent" | "user") =>
  ReviewThreadDetails.make({
    thread: details.thread,
    messages: [
      ...details.messages,
      ReviewThreadMessage.make({
        id: ReviewThreadMessageId.make(id),
        threadId: details.thread.id,
        sequence: details.messages.length + 1,
        author,
        bodyMarkdown: MarkdownBody.make(`New ${author} message`),
        status: "complete",
        agentRunId: author === "agent" ? `${id}-run` : null,
        createdAt: "2026-07-12T09:02:00Z",
        updatedAt: "2026-07-12T09:02:00Z",
      }),
    ],
  })

const threadController = (
  overrides: Partial<ReviewThreadsController> = {},
): ReviewThreadsController => ({
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
  ...overrides,
})

const render = (node: ReactNode) => {
  const element = document.createElement("div")
  document.body.append(element)
  root = createRoot(element)
  flushSync(() => root?.render(node))
}

const buttonNamed = (name: string) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  )
  if (button === undefined) throw new Error(`Button not found: ${name}`)
  return button
}

const buttonsNamed = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
    (candidate) => candidate.textContent?.trim() === name,
  )

const setTextareaValue = (textarea: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
}

const nextAnimationFrame = () =>
  new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))

const threadActionMock = () =>
  vi.fn<(threadId: ReviewThreadId) => Promise<void>>(async () => undefined)

const threadMessageActionMock = () =>
  vi.fn<(threadId: ReviewThreadId, bodyMarkdown: string) => Promise<void>>(async () => undefined)
