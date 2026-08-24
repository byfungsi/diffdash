import { DEFAULT_CODE_THEME_PREFERENCES } from "@diffdash/domain/ai-settings"
import {
  LanguagePosition,
  LanguageRange,
  RepositoryLanguageLocation,
  RepositoryLanguageLocationLink,
  RepositoryLanguageLocationResult,
} from "@diffdash/domain/language"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { Option } from "effect"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import "../styles.css"
import { FloatingPaneWorkspace } from "@/shared/ui/floating-pane"
import { KeyboardShortcutProvider } from "@/shell/keyboard-shortcuts"
import { LanguageNavigationPeekContent } from "@/source-surface/language-navigation-capability"

import { CodeDefinitionPeek } from "./code-definition-peek"

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe("CodeDefinitionPeek", () => {
  it("goes to the selected result by button or contextual platform shortcut", async () => {
    const platform = vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel")
    const anchor = document.createElement("button")
    document.body.append(anchor)
    const container = document.createElement("div")
    container.style.height = "480px"
    container.style.width = "800px"
    document.body.append(container)
    const first = location("src/first.ts", 1, 2)
    const second = location("src/second.ts", 3, 4)
    const onNavigate = vi.fn<(selected: RepositoryLanguageLocationLink) => void>()
    let firstPreviewSignal: AbortSignal | null = null
    let previewRequest = 0
    const onLoadSource = (_path: RepositoryRelativePath, signal: AbortSignal) => {
      previewRequest += 1
      if (previewRequest === 1) {
        firstPreviewSignal = signal
        return new Promise<Option.Option<string>>(() => undefined)
      }
      return Promise.reject(new Error("Preview source failed"))
    }
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        <KeyboardShortcutProvider>
          <FloatingPaneWorkspace className="h-full w-full">
            <CodeDefinitionPeek
              codeThemes={DEFAULT_CODE_THEME_PREFERENCES}
              colorScheme="light"
              state={{
                anchor,
                content: LanguageNavigationPeekContent.cases.results.make({
                  kind: "definitions",
                  result: RepositoryLanguageLocationResult.make({
                    locations: [first, second],
                    truncated: false,
                  }),
                }),
                id: 1,
                origin: {
                  surfaceId: "src/source.ts",
                  range: new LanguageRange({
                    start: new LanguagePosition({ line: 0, character: 0 }),
                    end: new LanguagePosition({ line: 0, character: 6 }),
                  }),
                },
              }}
              onClose={() => undefined}
              onLoadSource={onLoadSource}
              onNavigate={onNavigate}
            />
          </FloatingPaneWorkspace>
        </KeyboardShortcutProvider>,
      )
    })

    const next = await vi.waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Next definition"]',
      )
      expect(button).not.toBeNull()
      return button
    })
    next?.click()
    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>('button[aria-current="true"]')?.textContent,
      ).toContain("second.ts")
      expect(firstPreviewSignal?.aborted).toBe(true)
      expect(document.body.textContent).toContain("Preview source failed")
    })

    const macShortcut = dispatchShortcut("d", { metaKey: true })
    expect(macShortcut.defaultPrevented).toBe(true)
    expect(onNavigate).toHaveBeenLastCalledWith(second)

    platform.mockReturnValue("Win32")
    const wrongPlatformShortcut = dispatchShortcut("d", { metaKey: true })
    expect(wrongPlatformShortcut.defaultPrevented).toBe(false)
    const windowsShortcut = dispatchShortcut("d", { ctrlKey: true })
    expect(windowsShortcut.defaultPrevented).toBe(true)
    expect(onNavigate).toHaveBeenCalledTimes(2)

    document.querySelector<HTMLButtonElement>('button[aria-current="true"]')?.click()
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Go to selected definition"]')
      ?.click()
    expect(onNavigate).toHaveBeenCalledTimes(3)
    expect(onNavigate).toHaveBeenLastCalledWith(second)

    root.unmount()
    root = null
    const inactiveShortcut = dispatchShortcut("d", { ctrlKey: true })
    expect(inactiveShortcut.defaultPrevented).toBe(false)
    expect(onNavigate).toHaveBeenCalledTimes(3)
  })
})

const location = (
  path: string,
  line: number,
  character: number,
): RepositoryLanguageLocationLink => {
  const position = LanguagePosition.make({ line, character })
  const range = LanguageRange.make({ start: position, end: position })
  return RepositoryLanguageLocationLink.make({
    originSelectionRange: Option.none(),
    target: RepositoryLanguageLocation.make({ path: RepositoryRelativePath.make(path), range }),
    targetSelectionRange: range,
  })
}

const dispatchShortcut = (
  key: string,
  modifiers: Pick<KeyboardEventInit, "ctrlKey" | "metaKey" | "shiftKey">,
) => {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    ...modifiers,
  })
  window.dispatchEvent(event)
  return event
}
