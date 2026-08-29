import {
  CommentDestination,
  type CommentSubmission,
  CommentSubmissionReceipt,
  OpenCodeConnectionSelection,
  OpenCodeSessionId,
  OpenCodeSessionSummary,
} from "@diffdash/domain/comment"
import { DEFAULT_CODE_THEME_PREFERENCES } from "@diffdash/domain/ai-settings"
import {
  CommentNote,
  CommentNoteId,
  ProjectCommentNoteContext,
} from "@diffdash/domain/comment-note"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { GitCommitSha } from "@diffdash/domain/repository-comparison"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { Effect, Option } from "effect"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, assert, describe, expect, it, vi } from "vitest"

import "@/styles.css"
import { CodeFileViewer } from "@/project-workspace/code-file-viewer"
import type { CommentNotesOperations } from "@/platform/comment-notes"
import { CommentSubmissionContext } from "./comment-submission-context"
import {
  ReviewCommentsActivityPane,
  ReviewCommentsCodeSourceContribution,
} from "./code-comments-contribution"
import {
  REVIEW_COMMENTS_CODE_SOURCE_ID,
  REVIEW_COMMENTS_EXTENSION_ID,
} from "./review-comments-extension"
import { ReviewCommentsStateControllerProvider } from "./review-comments-provider"
import { TrustedExtensionRegistrationToken } from "../extension-registry"
import { CodeSurfaceCapabilityProvider } from "../code/code-surface-capability"

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
    ownerRegistrationToken: new TrustedExtensionRegistrationToken(),
    component: ReviewCommentsCodeSourceContribution,
  },
]
const commentNotes = {
  list: () => Effect.succeed([]),
  create: () => Effect.die("Note creation must not run in Review mode"),
  delete: () => Effect.die("Note deletion must not run in Review mode"),
  clear: () => Effect.die("Note clearing must not run in Review mode"),
  send: () => Effect.die("Note delivery must not run in Review mode"),
}

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

  it("opens another composer on a line that already has a note without an agent connection", async () => {
    let noteSequence = 0
    const notes: CommentNotesOperations = {
      list: () => Effect.succeed([]),
      create: ({ projectId: noteProjectId, subject, body }) =>
        Effect.sync(() => {
          noteSequence += 1
          return CommentNote.make({
            id: CommentNoteId.make(`note-${String(noteSequence)}`),
            projectId: noteProjectId,
            subject,
            body,
            createdAt: "2026-08-29T12:00:00.000Z",
          })
        }),
      delete: () => Effect.void,
      clear: () => Effect.void,
      send: () => Effect.die("Note delivery must not run without a connection"),
    }
    renderHarness(projectId, vi.fn(), Option.some(gitRevision), revision, {
      commentNotes: notes,
      connection: Option.none(),
      mode: "notes",
      renderActivityPane: false,
    })

    const line = await codeLine(0)
    line.click()
    const firstComposer = await vi.waitFor(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Code comment"]',
      )
      expect(textarea).not.toBeNull()
      return textarea!
    })
    setTextareaValue(firstComposer, "First note")
    const addNote = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Add note",
    )
    assert(addNote !== undefined)
    addNote.click()
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("First note")
      expect(document.querySelector('textarea[aria-label="Code comment"]')).toBeNull()
    })

    const annotatedLine = await codeLine(0)
    annotatedLine.click()
    const secondComposer = await vi.waitFor(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Code comment"]',
      )
      expect(textarea).not.toBeNull()
      return textarea!
    })
    setTextareaValue(secondComposer, "Second note")
    const addSecondNote = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Add note",
    )
    assert(addSecondNote !== undefined)
    addSecondNote.click()
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("First note")
      expect(document.body.textContent).toContain("Second note")
      expect(document.querySelector('textarea[aria-label="Code comment"]')).toBeNull()
    })
  })
})

const renderHarness = (
  activeProjectId: ReviewProjectId,
  submit: (submission: CommentSubmission) => Promise<CommentSubmissionReceipt>,
  activeGitRevision: Option.Option<GitCommitSha>,
  workspaceRevision: ReviewRevision = revision,
  options: {
    readonly commentNotes?: CommentNotesOperations
    readonly connection?: Option.Option<OpenCodeConnectionSelection>
    readonly mode?: "notes" | "review"
    readonly renderActivityPane?: boolean
  } = {},
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
      <ReviewCommentsStateControllerProvider
        commentNotes={options.commentNotes ?? commentNotes}
        connection={options.connection ?? Option.some(activeConnection)}
        mode={options.mode ?? "review"}
        noteContext={ProjectCommentNoteContext.make({})}
        projectId={activeProjectId}
        onModeChange={() => Promise.resolve()}
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
            {options.renderActivityPane === false ? null : (
              <CodeSurfaceCapabilityProvider
                capability={{ workspaceRevision, selectedPath: path, selectPath: () => undefined }}
              >
                <ReviewCommentsActivityPane
                  location={{ surface: "code", projectId: activeProjectId }}
                  paneHost={{
                    contextOpen: true,
                    detailOpen: false,
                    contextActions: null,
                    openContext: () => undefined,
                    openDetail: () => undefined,
                    closeContext: () => undefined,
                    closeDetail: () => undefined,
                    showMain: () => undefined,
                  }}
                />
              </CodeSurfaceCapabilityProvider>
            )}
          </div>
        </CommentSubmissionContext>
      </ReviewCommentsStateControllerProvider>,
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
