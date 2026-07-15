import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createDiffDashBrowserWindowOptions,
  isExternalUrlAllowed,
  isInternalNavigationAllowed,
  normalizeReviewFilePath,
  resolveContainedRepositoryPath,
} from "./electron-policy"

describe("Electron policy", () => {
  it("locks the BrowserWindow security boundary", () => {
    expect(
      createDiffDashBrowserWindowOptions({
        iconPath: "/app/icon.png",
        preloadPath: "/app/preload.mjs",
      }),
    ).toEqual({
      width: 1320,
      height: 860,
      minWidth: 1080,
      minHeight: 720,
      title: "DiffDash",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 18 },
      show: false,
      backgroundColor: "#ffffff",
      autoHideMenuBar: true,
      icon: "/app/icon.png",
      webPreferences: {
        preload: "/app/preload.mjs",
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    })
    expect(
      createDiffDashBrowserWindowOptions({ iconPath: null, preloadPath: "/app/preload.mjs" }),
    ).not.toHaveProperty("icon")
  })

  it("allows only the current lowercase HTTP external URL policy", () => {
    expect(isExternalUrlAllowed("https://example.com/review")).toBe(true)
    expect(isExternalUrlAllowed("http://example.com/review")).toBe(true)
    expect(isExternalUrlAllowed("HTTPS://example.com/review")).toBe(false)
    expect(isExternalUrlAllowed("file:///tmp/review")).toBe(false)
    expect(isExternalUrlAllowed("javascript:alert(1)")).toBe(false)
    expect(isExternalUrlAllowed("diffdash://review/1")).toBe(false)
  })

  it("preserves the current renderer navigation allowlist", () => {
    const currentUrl = "file:///app/index.html"
    expect(isInternalNavigationAllowed(currentUrl, currentUrl)).toBe(true)
    expect(isInternalNavigationAllowed("file:///another/location.html", currentUrl)).toBe(true)
    expect(isInternalNavigationAllowed("http://localhost:5173/review", currentUrl)).toBe(true)
    expect(isInternalNavigationAllowed("http://localhost/review", currentUrl)).toBe(false)
    expect(isInternalNavigationAllowed("https://localhost:5173/review", currentUrl)).toBe(false)
    expect(isInternalNavigationAllowed("http://127.0.0.1:5173/review", currentUrl)).toBe(false)
    expect(isInternalNavigationAllowed("https://example.com/review", currentUrl)).toBe(false)
  })

  it("normalizes separators and rejects explicit traversal", () => {
    expect(normalizeReviewFilePath("src\\review\\app.ts")).toBe("src/review/app.ts")
    expect(normalizeReviewFilePath("./src//app.ts")).toBe("./src//app.ts")
    expect(() => normalizeReviewFilePath("src/../secrets.txt")).toThrow(
      "Cannot open a file outside the repository checkout",
    )
    expect(() => normalizeReviewFilePath("src\\..\\secrets.txt")).toThrow(
      "Cannot open a file outside the repository checkout",
    )
  })

  it("resolves only paths contained by the repository root", () => {
    const rootPath = resolve("/tmp/diffdash-policy-repository")
    expect(resolveContainedRepositoryPath(rootPath, "src/app.ts")).toBe(
      resolve(rootPath, "src/app.ts"),
    )
    expect(resolveContainedRepositoryPath(rootPath, "")).toBe(rootPath)
    expect(() => resolveContainedRepositoryPath(rootPath, resolve(rootPath, "src/app.ts"))).toThrow(
      "Cannot open an absolute file path from a review",
    )
    expect(() => resolveContainedRepositoryPath(rootPath, "../outside.ts")).toThrow(
      "Cannot open a file outside the repository checkout",
    )
    expect(() => resolveContainedRepositoryPath(rootPath, "..notes")).toThrow(
      "Cannot open a file outside the repository checkout",
    )
  })
})
