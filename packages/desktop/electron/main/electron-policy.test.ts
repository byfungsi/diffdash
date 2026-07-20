import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  createDiffDashBrowserWindowOptions,
  createRendererNavigationHandlers,
  createRendererSecurityPolicy,
  normalizeReviewFilePath,
  resolveContainedRepositoryPath,
} from "./electron-policy"
import type { RendererFrameIdentity, RendererWebContentsIdentity } from "./electron-policy"

const packagedRendererUrl = "file:///Applications/DiffDash.app/renderer/index.html"

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

  it("ignores the development URL in packaged mode and trusts only the exact document", () => {
    const policy = securityPolicy({
      developmentRendererUrl: "http://localhost:5173",
      isPackaged: true,
    })

    expect(policy.rendererEntryUrl).toBe(packagedRendererUrl)
    expect(policy.isRendererNavigationAllowed(packagedRendererUrl)).toBe(true)
    expect(policy.isRendererNavigationAllowed(`${packagedRendererUrl}#review`)).toBe(false)
    expect(policy.isRendererNavigationAllowed(`${packagedRendererUrl}?review=1`)).toBe(false)
    expect(policy.isRendererNavigationAllowed("file:///tmp/renderer/index.html")).toBe(false)
    expect(policy.isRendererNavigationAllowed("file:///tmp/index.html")).toBe(false)
    expect(policy.isRendererNavigationAllowed("http://localhost:5173")).toBe(false)
  })

  it("trusts only the configured development origin while unpackaged", () => {
    const policy = securityPolicy({
      developmentRendererUrl: "http://localhost:5173/app",
      isPackaged: false,
    })

    expect(policy.rendererEntryUrl).toBe("http://localhost:5173/app")
    expect(policy.isRendererNavigationAllowed("http://localhost:5173/review?number=1")).toBe(true)
    expect(policy.isRendererNavigationAllowed("http://localhost:4173/review")).toBe(false)
    expect(policy.isRendererNavigationAllowed("https://localhost:5173/review")).toBe(false)
    expect(policy.isRendererNavigationAllowed("http://127.0.0.1:5173/review")).toBe(false)
    expect(policy.isRendererNavigationAllowed("http://review.localhost:5173/review")).toBe(false)
    expect(policy.isRendererNavigationAllowed("blob:http://localhost:5173/review")).toBe(false)
    expect(policy.isRendererNavigationAllowed(packagedRendererUrl)).toBe(false)
  })

  it("requires valid mode-specific renderer protocols", () => {
    expect(() => securityPolicy({ packagedRendererUrl: "https://example.com/index.html" })).toThrow(
      "Packaged renderer URL must use the file protocol",
    )
    expect(() =>
      securityPolicy({ developmentRendererUrl: "file:///tmp/index.html", isPackaged: false }),
    ).toThrow("Development renderer URL must use HTTP or HTTPS")
    expect(() => securityPolicy({ packagedRendererUrl: "not a URL" })).toThrow(
      "Invalid packaged renderer URL",
    )
  })

  it("requires the trusted top frame, exact sender URL, and canonical renderer URL for IPC", () => {
    expect(senderIsTrusted()).toBe(true)
    expect(senderIsTrusted({ senderFrame: "subframe" })).toBe(false)
    expect(senderIsTrusted({ senderFrame: "missing" })).toBe(false)
    expect(senderIsTrusted({ senderUrl: `${packagedRendererUrl}#changed` })).toBe(false)
    expect(senderIsTrusted({ destroyed: true })).toBe(false)
    expect(senderIsTrusted({ trustedIdentity: false })).toBe(false)
    expect(senderIsTrusted({ frameUrl: "file:///tmp/renderer/index.html" })).toBe(false)
    expect(senderIsTrusted({ frameUrl: "http://localhost:5173" })).toBe(false)
    expect(
      senderIsTrusted({
        developmentRendererUrl: "http://localhost:5173",
        frameUrl: "http://localhost:5173/review",
        isPackaged: false,
      }),
    ).toBe(true)
    expect(
      senderIsTrusted({
        developmentRendererUrl: "http://localhost:5173",
        frameUrl: "http://127.0.0.1:5173/review",
        isPackaged: false,
      }),
    ).toBe(false)
  })

  it("parses and delegates only HTTP(S) external URLs", async () => {
    const openExternal = vi.fn<(url: string) => Promise<void>>(async () => undefined)
    const policy = securityPolicy({ openExternal })

    await expect(policy.openExternalUrl("HTTPS://Example.COM/review?q=1")).resolves.toBe(true)
    await expect(policy.openExternalUrl("http://example.com/review")).resolves.toBe(true)
    await expect(policy.openExternalUrl("file:///tmp/review")).resolves.toBe(false)
    await expect(policy.openExternalUrl("javascript:alert(1)")).resolves.toBe(false)
    await expect(policy.openExternalUrl("not a URL")).resolves.toBe(false)

    expect(openExternal.mock.calls).toEqual([
      ["https://example.com/review?q=1"],
      ["http://example.com/review"],
    ])
  })

  it("denies new windows, externalizes blocked navigations, and handles opener rejection", async () => {
    const openExternal = vi.fn<(url: string) => Promise<void>>()
    openExternal.mockRejectedValue(new Error("Browser unavailable"))
    const handlers = createRendererNavigationHandlers(securityPolicy({ openExternal }))
    const allowedNavigation = { preventDefault: vi.fn<() => void>() }
    const blockedNavigation = { preventDefault: vi.fn<() => void>() }

    handlers.handleNavigation(allowedNavigation, packagedRendererUrl)
    handlers.handleNavigation(blockedNavigation, "https://example.com/review")
    expect(handlers.handleWindowOpen("https://example.com/new")).toEqual({ action: "deny" })
    expect(handlers.handleWindowOpen(packagedRendererUrl)).toEqual({ action: "deny" })
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0))

    expect(allowedNavigation.preventDefault).not.toHaveBeenCalled()
    expect(blockedNavigation.preventDefault).toHaveBeenCalledOnce()
    expect(openExternal.mock.calls).toEqual([
      ["https://example.com/review"],
      ["https://example.com/new"],
    ])
  })

  it("keeps renderer connections same-origin without localhost CSP grants", () => {
    const rendererHtml = readFileSync(resolve(__dirname, "../../src/renderer/index.html"), "utf8")

    expect(rendererHtml).toContain("connect-src 'self'")
    expect(rendererHtml).not.toMatch(/(?:localhost|127\.0\.0\.1|ws:\/\/)/)
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
    const rootPath = mkdtempSync(join(tmpdir(), "diffdash-policy-repository-"))
    mkdirSync(join(rootPath, "src"))
    writeFileSync(join(rootPath, "src", "app.ts"), "export {}")
    writeFileSync(join(rootPath, "..notes"), "notes")
    try {
      expect(resolveContainedRepositoryPath(rootPath, "src/app.ts")).toBe(
        realpathSync(resolve(rootPath, "src/app.ts")),
      )
      expect(resolveContainedRepositoryPath(rootPath, "")).toBe(realpathSync(rootPath))
      expect(() =>
        resolveContainedRepositoryPath(rootPath, resolve(rootPath, "src/app.ts")),
      ).toThrow("Cannot open an absolute file path from a review")
      expect(() => resolveContainedRepositoryPath(rootPath, "../outside.ts")).toThrow(
        "Cannot open a file outside the repository checkout",
      )
      expect(() => resolveContainedRepositoryPath(rootPath, "..notes")).toThrow(
        "Cannot open a file outside the repository checkout",
      )
    } finally {
      rmSync(rootPath, { force: true, recursive: true })
    }
  })

  it("rejects repository symlinks that resolve outside the checkout", () => {
    const rootPath = mkdtempSync(join(tmpdir(), "diffdash-policy-repository-"))
    const outsidePath = mkdtempSync(join(tmpdir(), "diffdash-policy-outside-"))
    writeFileSync(join(outsidePath, "secret.txt"), "outside")
    symlinkSync(outsidePath, join(rootPath, "linked-outside"), "dir")
    try {
      expect(() => resolveContainedRepositoryPath(rootPath, "linked-outside/secret.txt")).toThrow(
        "Cannot open a file outside the repository checkout",
      )
    } finally {
      rmSync(rootPath, { force: true, recursive: true })
      rmSync(outsidePath, { force: true, recursive: true })
    }
  })
})

const securityPolicy = ({
  developmentRendererUrl,
  isPackaged = true,
  isTrustedWebContents = () => true,
  openExternal = async () => undefined,
  packagedRendererUrl: packagedUrl = packagedRendererUrl,
}: {
  readonly developmentRendererUrl?: string
  readonly isPackaged?: boolean
  readonly isTrustedWebContents?: (webContents: RendererWebContentsIdentity) => boolean
  readonly openExternal?: (url: string) => Promise<void>
  readonly packagedRendererUrl?: string
} = {}) =>
  createRendererSecurityPolicy({
    developmentRendererUrl,
    isPackaged,
    isTrustedWebContents,
    openExternal,
    packagedRendererUrl: packagedUrl,
  })

const senderIsTrusted = ({
  developmentRendererUrl,
  destroyed = false,
  frameUrl = packagedRendererUrl,
  isPackaged = true,
  senderFrame = "main",
  senderUrl = frameUrl,
  trustedIdentity = true,
}: {
  readonly developmentRendererUrl?: string
  readonly destroyed?: boolean
  readonly frameUrl?: string
  readonly isPackaged?: boolean
  readonly senderFrame?: "main" | "missing" | "subframe"
  readonly senderUrl?: string
  readonly trustedIdentity?: boolean
} = {}) => {
  const mainFrame: RendererFrameIdentity = { url: frameUrl }
  const sender: RendererWebContentsIdentity = {
    getURL: () => senderUrl,
    isDestroyed: () => destroyed,
    mainFrame,
  }
  const policy = securityPolicy({
    ...(developmentRendererUrl === undefined ? {} : { developmentRendererUrl }),
    isPackaged,
    isTrustedWebContents: (candidate) => trustedIdentity && candidate === sender,
  })
  const invokedFrame =
    senderFrame === "missing" ? null : senderFrame === "main" ? mainFrame : { url: frameUrl }
  return policy.isTrustedIpcSender({ sender, senderFrame: invokedFrame })
}
