import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewKey,
  ReviewProjectId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import { AgentProviderFailure } from "@diffdash/domain/provider-failure"
import { AgentRunId, ReviewAgentProviderId } from "@diffdash/domain/review-agent"
import {
  AgentPromptVersion,
  CompletedAgentRun,
  FailedAgentRun,
  RunningAgentRun,
} from "@diffdash/domain/agent-run"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  CurrentReviewAnchor,
  CompletedAgentReviewThreadMessage,
  CompletedAgentReviewTurn,
  FailedAgentReviewThreadMessage,
  FailedAgentReviewTurn,
  LineReviewAnchor,
  MarkdownBody,
  PendingAgentReviewThreadMessage,
  PendingAgentReviewTurn,
  ProviderReviewThreadMessageFailure,
  ReviewThread,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadMessageId,
  UserReviewThreadMessage,
  UserReviewTurn,
} from "@diffdash/domain/review-thread"
import type { ReactNode } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { page, userEvent } from "vitest/browser"
import { installDiffDashApi } from "../test/app-browser-support"
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

beforeEach(() => {
  installDiffDashApi()
})

const lineAnchor = LineReviewAnchor.make({
  fileId: ReviewFileId.make("file-browser"),
  filePath: RepositoryRelativePath.make("src/example.ts"),
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

    const textarea = page.getByLabelText("Thread message")
    expect(document.activeElement).toBe(await textarea.findElement())
    await textarea.fill("**Check** this path")
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}")

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
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Claude authentication failed or expired",
    )
    expect(document.body.textContent).toContain("Sign in to Claude again")
    expect(document.body.textContent).not.toContain("private provider stderr")

    expect(document.querySelector('[aria-label="Reply to this line comment"]')).toBeNull()
    await page
      .getByLabelText("Agent message")
      .getByRole("button", { name: "Retry", exact: true })
      .click()
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

  it("renders tagged unavailable-anchor copy while retaining the original display location", () => {
    const outdated = threadDetails({
      currentAnchor: CurrentReviewAnchor.cases.Outdated.make({}),
    })
    render(
      <ReviewThreadPanel
        agentRunning={false}
        details={outdated}
        onAddUserMessage={threadMessageActionMock()}
        onRefresh={threadActionMock()}
      />,
    )

    expect(document.body.textContent).toContain("Outdated")
    expect(document.querySelector("article")?.getAttribute("aria-label")).toContain(
      "src/example.ts:7",
    )

    render(
      <ReviewThreadPanel
        agentRunning={false}
        details={threadDetails({
          currentAnchor: CurrentReviewAnchor.cases.Unresolved.make({}),
        })}
        onAddUserMessage={threadMessageActionMock()}
        onRefresh={threadActionMock()}
      />,
    )
    expect(document.body.textContent).toContain("Anchor unavailable")
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

    await page.getByLabelText("Thread message").fill("Can you explain the edge case?")
    await page.getByRole("button", { name: "Send", exact: true }).click()
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
    expect(page.getByRole("button", { name: "Retry", exact: true }).all()).toHaveLength(0)
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
    await page.getByRole("button", { name: "Retry", exact: true }).last().click()
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
    await page.getByRole("button", { name: "Retry", exact: true }).click()
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

  it("shows a sidebar header action, loading state, and retryable load errors", async () => {
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
        onOpenDetail={() => undefined}
      >
        <button type="button">Agent settings</button>
      </ReviewThreadListPane>
    )
    render(sidebar(true, null))
    expect(document.body.textContent).not.toContain("1 thread")
    expect(page.getByRole("button", { name: "Agent settings", exact: true }).query()).not.toBeNull()
    expect(document.querySelector("[data-review-thread-line-label]")?.textContent).toBe("R7")
    expect(document.querySelector(".lucide-move-right")).toBeNull()
    expect(document.querySelector("output")?.textContent).toContain("Loading")

    flushSync(() => root?.render(sidebar(false, "Could not load review threads")))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not load review threads",
    )
    await page.getByRole("button", { name: "Retry", exact: true }).click()
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
})

const threadDetails = ({
  previousRevision = false,
  pending = true,
  currentAnchor = CurrentReviewAnchor.cases.Active.make({ anchor: lineAnchor }),
}: {
  readonly previousRevision?: boolean
  readonly pending?: boolean
  readonly currentAnchor?: CurrentReviewAnchor
} = {}) => {
  const threadId = ReviewThreadId.make("thread-1")
  const currentRevision = ReviewRevision.make("head-current")
  const originalRevision = ReviewRevision.make(previousRevision ? "head-previous" : "head-current")
  const thread = ReviewThread.make({
    id: threadId,
    repoId: ReviewProjectId.make("repo-1"),
    reviewKey: ReviewKey.make("github:fungsi/diffdash#65"),
    prNumber: 65,
    baseRevision: ReviewRevision.make("base-previous"),
    headRevision: originalRevision,
    currentBaseRevision: ReviewRevision.make("base-current"),
    currentHeadRevision: currentRevision,
    originalAnchor: lineAnchor,
    currentAnchor,
    createdAt: "2026-07-12T09:00:00Z",
    updatedAt: "2026-07-12T09:01:00Z",
  })
  const runIdentity = (id: string, startedAt: string) => ({
    id: AgentRunId.make(id),
    threadId,
    reviewKey: thread.reviewKey,
    baseRevision: thread.baseRevision,
    headRevision: thread.headRevision,
    provider: ReviewAgentProviderId.make("fixture"),
    model: "fixture-model",
    promptVersion: AgentPromptVersion.make("fixture-v1"),
    startedAt,
  })
  const userMessage = UserReviewThreadMessage.make({
    id: ReviewThreadMessageId.make("message-user"),
    threadId,
    sequence: 1,
    bodyMarkdown: MarkdownBody.make("**Check** the `value`."),
    createdAt: "2026-07-12T09:00:00Z",
    updatedAt: "2026-07-12T09:00:00Z",
  })
  const responseIdentity = {
    id: ReviewThreadMessageId.make(pending ? "message-pending" : "message-complete"),
    threadId,
    sequence: 2,
    agentRunId: AgentRunId.make("run-1"),
    createdAt: "2026-07-12T09:00:10Z",
    updatedAt: "2026-07-12T09:00:10Z",
  }
  const responseTurn = pending
    ? PendingAgentReviewTurn.make({
        message: PendingAgentReviewThreadMessage.make(responseIdentity),
        run: RunningAgentRun.make(runIdentity("run-1", responseIdentity.createdAt)),
      })
    : CompletedAgentReviewTurn.make({
        message: CompletedAgentReviewThreadMessage.make({
          ...responseIdentity,
          bodyMarkdown: MarkdownBody.make("The edge case is covered."),
        }),
        run: CompletedAgentRun.make({
          ...runIdentity("run-1", responseIdentity.createdAt),
          completedAt: responseIdentity.updatedAt,
        }),
      })
  const failedMessage = FailedAgentReviewThreadMessage.make({
    id: ReviewThreadMessageId.make("message-failed"),
    threadId,
    sequence: 3,
    agentRunId: AgentRunId.make("run-2"),
    failure: ProviderReviewThreadMessageFailure.make({
      details: AgentProviderFailure.make({
        version: 1,
        providerId: ReviewAgentProviderId.make("claude"),
        capability: "review-thread",
        category: "authentication",
        processKind: "exit",
        exitCode: 1,
        signal: null,
        httpStatus: null,
        retryAfterSeconds: null,
        resetsAt: null,
      }),
    }),
    createdAt: "2026-07-12T09:01:00Z",
    updatedAt: "2026-07-12T09:01:00Z",
  })
  return ReviewThreadDetails.make({
    thread,
    conversation: [
      UserReviewTurn.make({ message: userMessage }),
      responseTurn,
      FailedAgentReviewTurn.make({
        message: failedMessage,
        run: FailedAgentRun.make({
          ...runIdentity("run-2", failedMessage.createdAt),
          error: "Agent response failed.",
          completedAt: failedMessage.updatedAt,
        }),
      }),
    ],
  })
}

const userOnlyThreadDetails = () => {
  const populated = threadDetails({ pending: false })
  const initialMessage = populated.messages[0]
  if (initialMessage?._tag !== "User") throw new Error("Expected an initial user message")
  return ReviewThreadDetails.make({
    thread: populated.thread,
    conversation: [UserReviewTurn.make({ message: initialMessage })],
  })
}

const appendMessage = (details: ReviewThreadDetails, id: string, author: "agent" | "user") =>
  ReviewThreadDetails.make({
    thread: details.thread,
    conversation: [
      ...details.conversation,
      ...(author === "user"
        ? [
            UserReviewTurn.make({
              message: UserReviewThreadMessage.make({
                id: ReviewThreadMessageId.make(id),
                threadId: details.thread.id,
                sequence: details.messages.length + 1,
                bodyMarkdown: MarkdownBody.make(`New ${author} message`),
                createdAt: "2026-07-12T09:02:00Z",
                updatedAt: "2026-07-12T09:02:00Z",
              }),
            }),
          ]
        : [
            CompletedAgentReviewTurn.make({
              message: CompletedAgentReviewThreadMessage.make({
                id: ReviewThreadMessageId.make(id),
                threadId: details.thread.id,
                sequence: details.messages.length + 1,
                bodyMarkdown: MarkdownBody.make(`New ${author} message`),
                agentRunId: AgentRunId.make(`${id}-run`),
                createdAt: "2026-07-12T09:02:00Z",
                updatedAt: "2026-07-12T09:02:00Z",
              }),
              run: CompletedAgentRun.make({
                id: AgentRunId.make(`${id}-run`),
                threadId: details.thread.id,
                reviewKey: details.thread.reviewKey,
                baseRevision: details.thread.baseRevision,
                headRevision: details.thread.headRevision,
                provider: ReviewAgentProviderId.make("fixture"),
                model: "fixture-model",
                promptVersion: AgentPromptVersion.make("fixture-v1"),
                startedAt: "2026-07-12T09:02:00Z",
                completedAt: "2026-07-12T09:02:00Z",
              }),
            }),
          ]),
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

const nextAnimationFrame = () =>
  new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))

const threadActionMock = () =>
  vi.fn<(threadId: ReviewThreadId) => Promise<void>>(async () => undefined)

const threadMessageActionMock = () =>
  vi.fn<(threadId: ReviewThreadId, bodyMarkdown: string) => Promise<void>>(async () => undefined)
