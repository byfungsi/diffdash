import { DEFAULT_CODE_THEME_PREFERENCES } from "@diffdash/domain/ai-settings"
import { CodeLineChangeRange } from "@diffdash/domain/code-line-change"
import {
  LanguagePosition,
  LanguageRange,
  LanguageOperationError,
  RepositoryLanguageLocation,
  RepositoryLanguageLocationLink,
  RepositoryLanguageLocationResult,
} from "@diffdash/domain/language"
import { ReviewRevision } from "@diffdash/domain/review-identity"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { Option } from "effect"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, assert, describe, expect, it, vi } from "vitest"
import { page } from "vitest/browser"

import "../styles.css"
import { isMacPlatform } from "@/shell/keyboard-shortcut-platform"
import { isHTMLElement } from "@/shared/dom"
import { FloatingPaneWorkspace } from "@/shared/ui/floating-pane"
import {
  REVIEW_COMMENTS_CODE_SOURCE_ID,
  REVIEW_COMMENTS_EXTENSION_ID,
} from "@/extensions/review-comments/review-comments-extension"
import { ReviewCommentsCodeSourceContribution } from "@/extensions/review-comments/code-comments-contribution"
import { ReviewCommentsStateProvider } from "@/extensions/review-comments/review-comments-provider"
import { CodeFileViewer } from "./code-file-viewer"

let root: Root | null = null
const projectId = ReviewProjectId.make("code-viewer-project")
const revision = ReviewRevision.make("0".repeat(40))
const CODE_COMMENT_CONTRIBUTIONS = [
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

describe("CodeFileViewer", () => {
  it("preserves another runtime's search highlights when one viewer is removed", async () => {
    const container = document.createElement("div")
    container.style.height = "480px"
    container.style.width = "800px"
    document.body.append(container)
    root = createRoot(container)
    const renderViewers = (includeFirst: boolean) => {
      flushSync(() => {
        root?.render(
          <div>
            {includeFirst ? (
              <CodeFileViewer
                key="first"
                codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
                colorScheme="light"
                contents={"const needle = 1\n"}
                path={RepositoryRelativePath.make("src/first.ts")}
                projectId={projectId}
                revision={revision}
              />
            ) : null}
            <CodeFileViewer
              key="second"
              codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
              colorScheme="light"
              contents={"const needle = 2\n"}
              path={RepositoryRelativePath.make("src/second.ts")}
              projectId={projectId}
              revision={revision}
            />
          </div>,
        )
      })
    }
    renderViewers(true)
    window.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "f", metaKey: true }),
    )
    const inputs = await vi.waitFor(() => {
      const found = document.querySelectorAll<HTMLInputElement>(
        'input[aria-label="Search current file"]',
      )
      expect(found).toHaveLength(2)
      return found
    })
    inputs.forEach((input) => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
      valueSetter?.call(input, "needle")
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
    })

    await vi.waitFor(() => {
      expect(CSS.highlights.get("diffdash-code-search-active")?.size).toBe(2)
    })
    renderViewers(false)
    await vi.waitFor(() => {
      expect(CSS.highlights.get("diffdash-code-search-active")?.size).toBe(1)
    })
  })

  it("decorates added, modified, and deleted lines in the code gutter", async () => {
    const container = document.createElement("div")
    container.style.height = "480px"
    container.style.width = "800px"
    document.body.append(container)
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        <CodeFileViewer
          codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
          colorScheme="light"
          contents={"one\ntwo\nthree\nfour\n"}
          lineChanges={[
            CodeLineChangeRange.make({ kind: "added", startLine: 1, endLine: 1 }),
            CodeLineChangeRange.make({ kind: "modified", startLine: 2, endLine: 3 }),
            CodeLineChangeRange.make({ kind: "deleted", startLine: 4, endLine: 4 }),
          ]}
          path={RepositoryRelativePath.make("src/changed.ts")}
          projectId={projectId}
          revision={revision}
        />,
      )
    })

    await vi.waitFor(() => {
      const shadowRoot = document.querySelector("diffs-container")?.shadowRoot
      expect(
        shadowRoot?.querySelector<HTMLElement>('[data-line-index="0"]')?.dataset.codeLineChange,
      ).toBe("added")
      expect(
        shadowRoot?.querySelector<HTMLElement>('[data-line-index="1"]')?.dataset.codeLineChange,
      ).toBe("modified")
      expect(
        shadowRoot?.querySelector<HTMLElement>('[data-line-index="2"]')?.dataset.codeLineChange,
      ).toBe("modified")
      expect(
        shadowRoot?.querySelector<HTMLElement>('[data-line-index="3"]')?.dataset.codeLineChange,
      ).toBe("deleted")
    })
  })

  it("renders one checkout file through Pierre CodeView", async () => {
    const path = RepositoryRelativePath.make("src/greeting.ts")
    const container = document.createElement("div")
    container.style.height = "480px"
    container.style.width = "800px"
    document.body.append(container)
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        <CodeFileViewer
          codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
          colorScheme="light"
          contents={'export const greeting = "hello"\n'}
          path={path}
          projectId={projectId}
          revision={revision}
        />,
      )
    })

    await vi.waitFor(() => {
      const file = document.querySelector("diffs-container")
      expect(file).not.toBeNull()
      expect(file?.shadowRoot?.textContent).toContain('export const greeting = "hello"')
    })

    flushSync(() => {
      root?.render(
        <CodeFileViewer
          codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
          colorScheme="light"
          contents={'export const greeting = "updated"\n'}
          path={path}
          projectId={projectId}
          revision={revision}
        />,
      )
    })
    await vi.waitFor(() => {
      expect(document.querySelector("diffs-container")?.shadowRoot?.textContent).toContain(
        'export const greeting = "updated"',
      )
    })

    flushSync(() => {
      root?.render(
        <CodeFileViewer
          codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
          colorScheme="light"
          contents="Aa"
          path={path}
          projectId={projectId}
          revision={revision}
        />,
      )
    })
    await vi.waitFor(() => {
      expect(document.querySelector("diffs-container")?.shadowRoot?.textContent).toContain("Aa")
    })
    flushSync(() => {
      root?.render(
        <CodeFileViewer
          codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
          colorScheme="light"
          contents="BB"
          path={path}
          projectId={projectId}
          revision={revision}
        />,
      )
    })
    await vi.waitFor(() => {
      expect(document.querySelector("diffs-container")?.shadowRoot?.textContent).toContain("BB")
    })
  })

  it("ends the scroll range at the final source line", async () => {
    const path = RepositoryRelativePath.make("src/long-file.ts")
    const container = document.createElement("div")
    container.style.height = "480px"
    container.style.width = "800px"
    document.body.append(container)
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        <CodeFileViewer
          codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
          colorScheme="light"
          contents={Array.from(
            { length: 60 },
            (_, index) => `export const line${index + 1} = ${index + 1}`,
          ).join("\n")}
          path={path}
          projectId={projectId}
          revision={revision}
        />,
      )
    })

    const scrollRoot = await vi.waitFor(() => {
      const candidate = container.querySelector("[data-code-file-scroll]")
      assert(isHTMLElement(candidate), "Code view root did not render")
      expect(candidate.scrollHeight).toBeGreaterThan(candidate.clientHeight)
      return candidate
    })
    scrollRoot.scrollTop = scrollRoot.scrollHeight
    scrollRoot.dispatchEvent(new Event("scroll"))

    await vi.waitFor(() => {
      expect(scrollRoot.scrollTop).toBeCloseTo(scrollRoot.scrollHeight - scrollRoot.clientHeight, 0)
      const lines = document
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]")
      const finalLine = lines?.item((lines?.length ?? 1) - 1)
      expect(finalLine?.textContent).toContain("line60")
      expect(
        scrollRoot.getBoundingClientRect().bottom -
          (finalLine?.getBoundingClientRect().bottom ?? 0),
      ).toBeLessThanOrEqual(20)
    })
  })

  it("explains the unsupported local destination after a code line click", async () => {
    const container = document.createElement("div")
    container.style.height = "480px"
    container.style.width = "800px"
    document.body.append(container)
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        <ReviewCommentsStateProvider connection={Option.none()} projectId={projectId}>
          <CodeFileViewer
            codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
            colorScheme="light"
            contents={'export const greeting = "hello"\n'}
            contributions={CODE_COMMENT_CONTRIBUTIONS}
            path={RepositoryRelativePath.make("src/greeting.ts")}
            projectId={projectId}
            revision={revision}
          />
        </ReviewCommentsStateProvider>,
      )
    })

    const line = await vi.waitFor(() => {
      const candidate = document
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector<HTMLElement>('[data-line-index="0"]')
      assert(isHTMLElement(candidate), "Code line did not render")
      return candidate
    })
    line.click()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        "Code comments in DiffDash are not supported yet. Connect OpenCode to comment on code.",
      )
    })
  })

  it("opens a code comment from the keyboard-selected line", async () => {
    const container = document.createElement("div")
    container.style.height = "480px"
    container.style.width = "800px"
    document.body.append(container)
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        <ReviewCommentsStateProvider connection={Option.none()} projectId={projectId}>
          <CodeFileViewer
            codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
            colorScheme="light"
            contents={'export const greeting = "hello"\n'}
            contributions={CODE_COMMENT_CONTRIBUTIONS}
            path={RepositoryRelativePath.make("src/greeting.ts")}
            projectId={projectId}
            revision={revision}
          />
        </ReviewCommentsStateProvider>,
      )
    })

    const scrollRoot = await vi.waitFor(() => {
      const candidate = container.querySelector("[data-code-file-scroll]")
      assert(isHTMLElement(candidate), "Code view root did not render")
      return candidate
    })
    scrollRoot.focus()
    scrollRoot.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        "Code comments in DiffDash are not supported yet. Connect OpenCode to comment on code.",
      )
    })
  })

  it("underlines a token hovered while the definition modifier is pressed", async () => {
    const container = document.createElement("div")
    container.style.height = "480px"
    container.style.width = "800px"
    document.body.append(container)
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        <CodeFileViewer
          codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
          colorScheme="light"
          contents={'export const greeting = "hello"\n'}
          path={RepositoryRelativePath.make("src/greeting.ts")}
          projectId={projectId}
          revision={revision}
        />,
      )
    })

    const token = await definitionToken("greeting")
    token.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        composed: true,
        ctrlKey: true,
        metaKey: true,
        pointerType: "mouse",
      }),
    )

    await vi.waitFor(() => {
      expect(token.hasAttribute("data-diffdash-definition-link")).toBe(true)
    })
  })

  it("navigates a single definition without opening a comment", async () => {
    const container = document.createElement("div")
    container.style.height = "480px"
    container.style.width = "800px"
    document.body.append(container)
    root = createRoot(container)
    const target = definition("src/target.ts", 4, 7)
    let resolveRequest = (_result: RepositoryLanguageLocationResult): void => undefined
    const pendingRequest = new Promise<RepositoryLanguageLocationResult>((resolve) => {
      resolveRequest = resolve
    })
    const request = vi.fn<
      (position: LanguagePosition, signal: AbortSignal) => Promise<RepositoryLanguageLocationResult>
    >(() => pendingRequest)
    const navigate = vi.fn<(location: RepositoryLanguageLocationLink) => void>()
    flushSync(() => {
      root?.render(
        <CodeFileViewer
          codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
          colorScheme="light"
          contents={'export const greeting = "hello"\n'}
          path={RepositoryRelativePath.make("src/greeting.ts")}
          projectId={projectId}
          revision={revision}
          onNavigateToDefinition={navigate}
          onRequestDefinitions={request}
        />,
      )
    })

    const token = await definitionToken("greeting")
    token.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        composed: true,
        button: 0,
        ctrlKey: true,
        metaKey: true,
      }),
    )
    token.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        composed: true,
        metaKey: true,
        pointerType: "mouse",
      }),
    )
    container
      .querySelector<HTMLElement>("[data-code-file-scroll]")
      ?.dispatchEvent(new Event("scroll"))
    expect(request.mock.calls[0]?.[1].aborted).toBe(false)
    resolveRequest(new RepositoryLanguageLocationResult({ locations: [target], truncated: false }))

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledOnce()
      expect(request.mock.calls[0]?.[0]).toEqual(
        new LanguagePosition({ line: 0, character: Number(token.dataset.char) }),
      )
      expect(navigate).toHaveBeenCalledWith(target)
      expect(document.body.textContent).not.toContain("Code comments in DiffDash")
    })
  })

  it("opens Peek Definition for an Alt-click even when one definition exists", async () => {
    const container = document.createElement("div")
    container.style.height = "480px"
    container.style.width = "800px"
    document.body.append(container)
    root = createRoot(container)
    const target = definition("src/target.ts", 4, 7)
    const navigate = vi.fn<(location: RepositoryLanguageLocationLink) => void>()
    let resolveRequest = (_result: RepositoryLanguageLocationResult): void => undefined
    const request = new Promise<RepositoryLanguageLocationResult>((resolve) => {
      resolveRequest = resolve
    })
    const requestDefinitions = () => request
    const loadDefinitionSource = async () => Option.some('export const greeting = "hello"\n')
    const renderViewer = (
      lineChanges: readonly CodeLineChangeRange[] = [],
      contents = 'export const greeting = "hello"\n',
    ) => {
      flushSync(() => {
        root?.render(
          <FloatingPaneWorkspace className="h-full w-full">
            <CodeFileViewer
              codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
              colorScheme="light"
              contents={contents}
              lineChanges={lineChanges}
              path={RepositoryRelativePath.make("src/greeting.ts")}
              projectId={projectId}
              revision={revision}
              onLoadDefinitionSource={loadDefinitionSource}
              onNavigateToDefinition={navigate}
              onRequestDefinitions={requestDefinitions}
            />
          </FloatingPaneWorkspace>,
        )
      })
    }
    renderViewer()

    const token = await definitionToken("greeting")
    await page.getByText("greeting", { exact: true }).click({ modifiers: ["Alt"] })
    renderViewer([CodeLineChangeRange.make({ kind: "modified", startLine: 1, endLine: 1 })])
    await vi.waitFor(() => {
      expect(
        document
          .querySelector("diffs-container")
          ?.shadowRoot?.querySelector<HTMLElement>('[data-line-index="0"]')?.dataset.codeLineChange,
      ).toBe("modified")
      expect(token.isConnected).toBe(true)
    })
    token.dispatchEvent(
      new PointerEvent("pointerout", {
        bubbles: true,
        composed: true,
        pointerType: "mouse",
        relatedTarget: container,
      }),
    )
    container
      .querySelector<HTMLElement>("[data-code-file-scroll]")
      ?.dispatchEvent(new Event("scroll"))
    resolveRequest(new RepositoryLanguageLocationResult({ locations: [target], truncated: false }))

    await vi.waitFor(() => {
      const peek = document.querySelector<HTMLElement>(
        '[role="dialog"][aria-label="Peek Definitions, 1 result"]',
      )
      expect(peek).not.toBeNull()
      expect(token.isConnected).toBe(true)
      assert(peek !== null, "Expected Peek Definitions to remain mounted")
      expect(getComputedStyle(peek).visibility).toBe("visible")
      expect(navigate).not.toHaveBeenCalled()
    })

    renderViewer(
      [CodeLineChangeRange.make({ kind: "modified", startLine: 1, endLine: 1 })],
      'export const greeting = "updated"\n',
    )
    await vi.waitFor(() => {
      const peek = document.querySelector<HTMLElement>(
        '[role="dialog"][aria-label="Peek Definitions, 1 result"]',
      )
      expect(token.isConnected).toBe(false)
      expect(peek).not.toBeNull()
      assert(peek !== null, "Expected Peek Definitions to survive the source rerender")
      expect(getComputedStyle(peek).visibility).toBe("visible")
    })
  })

  it("opens references from a bubbled primary-modifier Shift-click", async () => {
    const container = document.createElement("div")
    container.style.height = "480px"
    container.style.width = "800px"
    document.body.append(container)
    root = createRoot(container)
    const first = definition("src/first.ts", 1, 6)
    const second = definition("src/second.ts", 3, 2)
    const definitions = vi.fn<
      (position: LanguagePosition, signal: AbortSignal) => Promise<RepositoryLanguageLocationResult>
    >(async () => new RepositoryLanguageLocationResult({ locations: [], truncated: false }))
    let resolveReferences = (_result: RepositoryLanguageLocationResult): void => undefined
    const referenceRequest = new Promise<RepositoryLanguageLocationResult>((resolve) => {
      resolveReferences = resolve
    })
    const references = vi.fn<
      (position: LanguagePosition, signal: AbortSignal) => Promise<RepositoryLanguageLocationResult>
    >(() => referenceRequest)
    flushSync(() => {
      root?.render(
        <FloatingPaneWorkspace className="h-full w-full">
          <CodeFileViewer
            codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
            colorScheme="light"
            contents={'export const greeting = "hello"\n'}
            path={RepositoryRelativePath.make("src/greeting.ts")}
            projectId={projectId}
            revision={revision}
            onLoadDefinitionSource={async () => Option.some('export const greeting = "hello"\n')}
            onRequestDefinitions={definitions}
            onRequestReferences={references}
          />
        </FloatingPaneWorkspace>,
      )
    })

    const token = await definitionToken("greeting")
    const macPrimaryModifier = isMacPlatform()
    const selection = document.getSelection()
    const range = document.createRange()
    range.selectNodeContents(token)
    selection?.removeAllRanges()
    selection?.addRange(range)
    token.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        button: 0,
        composed: true,
        ctrlKey: !macPrimaryModifier,
        metaKey: macPrimaryModifier,
        shiftKey: true,
      }),
    )
    token.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        composed: true,
        ctrlKey: !macPrimaryModifier,
        metaKey: macPrimaryModifier,
        pointerType: "mouse",
        shiftKey: true,
      }),
    )
    container
      .querySelector<HTMLElement>("[data-code-file-scroll]")
      ?.dispatchEvent(new Event("scroll"))
    expect(references.mock.calls[0]?.[1].aborted).toBe(false)
    expect(document.getSelection()?.isCollapsed).toBe(true)
    resolveReferences(
      new RepositoryLanguageLocationResult({
        locations: [first, second],
        truncated: false,
      }),
    )

    await vi.waitFor(() => {
      const peek = document.querySelector(
        '[role="dialog"][aria-label="Peek References, 2 results"]',
      )
      expect(peek?.textContent).toContain("References (2)")
      expect(references).toHaveBeenCalled()
      expect(definitions).not.toHaveBeenCalled()
    })
  })

  it("opens Peek Definitions with a result tree and source preview", async () => {
    const container = document.createElement("div")
    container.style.height = "480px"
    container.style.width = "800px"
    document.body.append(container)
    root = createRoot(container)
    const first = definition("src/first.ts", 1, 6)
    const second = definition("src/second.ts", 3, 2)
    flushSync(() => {
      root?.render(
        <FloatingPaneWorkspace className="h-full w-full">
          <CodeFileViewer
            codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
            colorScheme="light"
            contents={`${Array.from({ length: 80 }, (_, index) => `const filler${index} = ${index}`).join("\n")}\nexport function greeting() {}\n`}
            path={RepositoryRelativePath.make("src/greeting.ts")}
            projectId={projectId}
            revision={revision}
            onLoadDefinitionSource={async (path) => {
              if (path === first.target.path) {
                return Option.some("zero\nexport const first = 1\ntwo")
              }
              return Option.some("zero\none\ntwo\nexport const second = 2")
            }}
            onNavigateToDefinition={vi.fn<(location: RepositoryLanguageLocationLink) => void>()}
            onRequestDefinitions={async () =>
              new RepositoryLanguageLocationResult({
                locations: [first, second],
                truncated: false,
              })
            }
          />
        </FloatingPaneWorkspace>,
      )
    })

    const scrollRoot = await vi.waitFor(() => {
      const candidate = container.querySelector<HTMLElement>("[data-code-file-scroll]")
      assert(isHTMLElement(candidate), "Code view root did not render")
      expect(candidate.scrollHeight).toBeGreaterThan(candidate.clientHeight)
      return candidate
    })
    scrollRoot.scrollTop = scrollRoot.scrollHeight
    scrollRoot.dispatchEvent(new Event("scroll"))

    const token = await definitionToken("greeting")
    token.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        composed: true,
        button: 0,
        ctrlKey: true,
        metaKey: true,
      }),
    )

    await vi.waitFor(() => {
      const peek = document.querySelector(
        '[role="dialog"][aria-label="Peek Definitions, 2 results"]',
      )
      expect(peek).not.toBeNull()
      expect(peek?.textContent).toContain("Definitions (2)")
      expect(peek?.textContent).toContain("src/first.ts:2:7")
      expect(peek?.textContent).toContain("src/second.ts:4:3")
      const workspace = document.querySelector<HTMLElement>("[data-floating-pane-workspace]")
      const peekRect = peek?.getBoundingClientRect()
      const workspaceRect = workspace?.getBoundingClientRect()
      expect(peekRect?.bottom).toBeLessThanOrEqual(workspaceRect?.bottom ?? 0)
      const preview = peek?.querySelector("diffs-container")?.shadowRoot
      expect(preview?.textContent).toContain("export const first = 1")
      expect(preview?.querySelectorAll("span").length).toBeGreaterThan(1)
      expect(
        preview
          ?.querySelector<HTMLElement>('[data-line-index="1"][data-selected-line]')
          ?.getBoundingClientRect().top,
      ).toBeGreaterThanOrEqual(peekRect?.top ?? 0)
    })
  })

  it("cancels a superseded language request and presents the typed failure", async () => {
    const container = document.createElement("div")
    container.style.height = "480px"
    container.style.width = "800px"
    document.body.append(container)
    root = createRoot(container)
    let firstSignal: AbortSignal | null = null
    let requestCount = 0
    const requestDefinitions = (_position: LanguagePosition, signal: AbortSignal) => {
      requestCount += 1
      if (requestCount === 1) {
        firstSignal = signal
        return new Promise<RepositoryLanguageLocationResult>(() => undefined)
      }
      return Promise.reject(
        LanguageOperationError.make({
          operation: "definitions",
          reason: "serverUnavailable",
          message: "TypeScript language service stopped.",
        }),
      )
    }
    flushSync(() => {
      root?.render(
        <FloatingPaneWorkspace className="h-full w-full">
          <CodeFileViewer
            codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
            colorScheme="light"
            contents={'export const greeting = "hello"\n'}
            path={RepositoryRelativePath.make("src/greeting.ts")}
            projectId={projectId}
            revision={revision}
            onLoadDefinitionSource={async () => Option.none()}
            onRequestDefinitions={requestDefinitions}
          />
        </FloatingPaneWorkspace>,
      )
    })

    const token = await definitionToken("greeting")
    for (let request = 0; request < 2; request += 1) {
      token.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          composed: true,
          button: 0,
          ctrlKey: true,
          metaKey: true,
        }),
      )
    }

    await vi.waitFor(() => {
      expect(firstSignal?.aborted).toBe(true)
      expect(document.body.textContent).toContain("TypeScript language service stopped.")
      expect(
        document.querySelector('[role="dialog"][aria-label="Peek Definitions unavailable"]'),
      ).not.toBeNull()
    })
  })
})

const definition = (
  path: string,
  line: number,
  character: number,
): RepositoryLanguageLocationLink => {
  const position = new LanguagePosition({ line, character })
  const range = new LanguageRange({ start: position, end: position })
  return new RepositoryLanguageLocationLink({
    originSelectionRange: Option.none(),
    target: new RepositoryLanguageLocation({ path: RepositoryRelativePath.make(path), range }),
    targetSelectionRange: range,
  })
}

const definitionToken = async (text: string): Promise<HTMLElement> =>
  vi.waitFor(() => {
    const tokens = document
      .querySelector("diffs-container")
      ?.shadowRoot?.querySelectorAll<HTMLElement>("[data-char]")
    const token = [...(tokens ?? [])].find((candidate) => candidate.textContent === text)
    assert(isHTMLElement(token), `Token ${text} did not render`)
    return token
  })
