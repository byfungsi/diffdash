import { DEFAULT_CODE_THEME_PREFERENCES } from "@diffdash/domain/ai-settings"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import "../styles.css"
import { CodeFileViewer } from "./code-file-viewer"

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

describe("CodeFileViewer", () => {
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
        />,
      )
    })

    const scrollRoot = await vi.waitFor(() => {
      const candidate = container.firstElementChild
      expect(candidate).toBeInstanceOf(HTMLElement)
      if (!(candidate instanceof HTMLElement)) throw new Error("Code view root did not render")
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
})
