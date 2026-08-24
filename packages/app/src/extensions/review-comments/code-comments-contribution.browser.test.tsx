import {
  CommentDestination,
  type CommentSubmission,
  CommentSubmissionReceipt,
  OpenCodeConnectionSelection,
  OpenCodeSessionId,
  OpenCodeSessionSummary,
} from "@diffdash/domain/comment"
import { DEFAULT_CODE_THEME_PREFERENCES } from "@diffdash/domain/ai-settings"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { GitCommitSha } from "@diffdash/domain/repository-comparison"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { Option } from "effect"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, assert, describe, expect, it, vi } from "vitest"

import "@/styles.css"
import { CodeFileViewer } from "@/project-workspace/code-file-viewer"
import { CommentSubmissionContext } from "./comment-submission-context"
import {
  ReviewCommentsActivityPane,
  ReviewCommentsCodeSourceContribution,
} from "./code-comments-contribution"
import {
  REVIEW_COMMENTS_CODE_SOURCE_ID,
  REVIEW_COMMENTS_EXTENSION_ID,
} from "./review-comments-extension"
import { ReviewCommentsStateProvider } from "./review-comments-provider"

let root: Root | null = null
const projectId = ReviewProjectId.make("code-comment-project")
const otherProjectId = ReviewProjectId.make("other-code-comment-project")
const path = RepositoryRelativePath.make("src/greeting.ts")
const revision = ReviewRevision.make("1".repeat(40))
const nextRevision = ReviewRevision.make("3".repeat(40))
const gitRevision = GitCommitSha.make("2".repeat(40))
const connection = OpenCodeConnectionSelection.make({
  projectId,
  planMode: true,
  session: OpenCodeSessionSummary.make({
    id: OpenCodeSessionId.make("ses_codeComments"),
    title: "Review source changes",
    directory: RepositoryCheckoutPath.make("/workspace/project"),
    updatedAt: 1,
  }),
})
const contributions = [
  {
    id: REVIEW_COMMENTS_CODE_SOURCE_ID,
    order: 500,
    ownerExtensionId: REVIEW_COMMENTS_EXTENSION_ID,
    component: ReviewCommentsCodeSourceContribution,
  },
]

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

describe("Review Comments Code contribution", () => {
  it("shares a controlled draft with the Comments pane and forwards it once", async () => {
    const submit = vi.fn<(submission: CommentSubmission) => Promise<CommentSubmissionReceipt>>(
      async () =>
        CommentSubmissionReceipt.cases.Forwarded.make({ sessionId: connection.session.id }),
    )
    renderHarness(projectId, submit, Option.some(gitRevision))

    const line = await codeLine(0)
    line.click()
    const textarea = await vi.waitFor(() => {
      const candidate = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Code comment"]',
      )
      expect(candidate).not.toBeNull()
      return candidate!
    })
    setTextareaValue(textarea, "Please rename this greeting")

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("src/greeting.ts:1")
      expect(document.body.textContent).toContain("Please rename this greeting")
      expect(document.body.textContent).toContain("Review source changes")
      expect(document.body.textContent).toContain("Plan mode")
    })
    const resume = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Resume / Focus"),
    )
    assert(resume !== undefined)
    textarea.blur()
    resume.click()
    await vi.waitFor(() => expect(document.activeElement).toBe(textarea))

    const send = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Send to OpenCode"),
    )
    assert(send !== undefined)
    send.click()

    await vi.waitFor(() => {
      expect(submit).toHaveBeenCalledOnce()
      expect(document.querySelector('textarea[aria-label="Code comment"]')).toBeNull()
      expect(document.body.textContent).toContain("Select a source line to start a comment.")
    })
    expect(submit.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        _tag: "Start",
        body: "Please rename this greeting",
        subject: expect.objectContaining({
          _tag: "CodeLine",
          projectId,
          revision: gitRevision,
          path,
          lineNumber: 1,
          lineContent: 'export const greeting = "hello"',
        }),
      }),
    )
  })

  it("keeps unsupported drafts actionable and clears them when the project changes", async () => {
    const submit = vi.fn<(submission: CommentSubmission) => Promise<CommentSubmissionReceipt>>()
    renderHarness(projectId, submit, Option.none())
    const line = await codeLine(0)
    line.click()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        "OpenCode comments require a committed Git revision.",
      )
      expect(document.body.textContent).toContain("src/greeting.ts:1")
    })
    renderHarness(otherProjectId, submit, Option.none())
    expect(document.body.textContent).toContain("Select a source line to start a comment.")
    expect(document.body.textContent).not.toContain("src/greeting.ts:1")
    expect(submit).not.toHaveBeenCalled()
  })

  it("discards a draft when the same project moves to another workspace revision", async () => {
    const submit = vi.fn<(submission: CommentSubmission) => Promise<CommentSubmissionReceipt>>()
    renderHarness(projectId, submit, Option.some(gitRevision))
    const line = await codeLine(0)
    line.click()
    await vi.waitFor(() => expect(document.body.textContent).toContain("src/greeting.ts:1"))

    renderHarness(projectId, submit, Option.some(gitRevision), nextRevision)
    expect(document.body.textContent).toContain("Select a source line to start a comment.")
    expect(document.body.textContent).not.toContain("src/greeting.ts:1")
    await vi.waitFor(() => {
      expect(document.querySelector('textarea[aria-label="Code comment"]')).toBeNull()
    })

    renderHarness(projectId, submit, Option.some(gitRevision), revision)
    expect(document.body.textContent).toContain("Select a source line to start a comment.")
    expect(document.body.textContent).not.toContain("src/greeting.ts:1")
  })
})

const renderHarness = (
  activeProjectId: ReviewProjectId,
  submit: (submission: CommentSubmission) => Promise<CommentSubmissionReceipt>,
  activeGitRevision: Option.Option<GitCommitSha>,
  workspaceRevision: ReviewRevision = revision,
) => {
  const container = document.body.firstElementChild ?? document.createElement("div")
  if (!container.isConnected) {
    container.setAttribute("style", "height: 480px; width: 1000px")
    document.body.append(container)
    root = createRoot(container)
  }
  const activeConnection = OpenCodeConnectionSelection.make({
    ...connection,
    projectId: activeProjectId,
  })
  flushSync(() => {
    root?.render(
      <ReviewCommentsStateProvider
        connection={Option.some(activeConnection)}
        projectId={activeProjectId}
      >
        <CommentSubmissionContext
          value={{
            destination: CommentDestination.cases.OpenCode.make({ connection: activeConnection }),
            submit,
          }}
        >
          <div className="grid h-full grid-cols-[1fr_320px]">
            <CodeFileViewer
              codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
              colorScheme="light"
              contents={'export const greeting = "hello"\n'}
              contributions={contributions}
              gitRevision={activeGitRevision}
              path={path}
              projectId={activeProjectId}
              revision={workspaceRevision}
            />
            <ReviewCommentsActivityPane
              surface="code"
              projectId={activeProjectId}
              workspaceRevision={workspaceRevision}
              selectedPath={path}
              selectPath={() => undefined}
            />
          </div>
        </CommentSubmissionContext>
      </ReviewCommentsStateProvider>,
    )
  })
}

const codeLine = (lineIndex: number): Promise<HTMLElement> =>
  vi.waitFor(() => {
    const line = document
      .querySelector("diffs-container")
      ?.shadowRoot?.querySelector<HTMLElement>(`[data-line-index="${String(lineIndex)}"]`)
    assert(line !== undefined && line !== null, "Code line did not render")
    return line
  })

const setTextareaValue = (textarea: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
}
