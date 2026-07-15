import { isAbsolute, relative, resolve } from "node:path"
import type { BrowserWindowConstructorOptions } from "electron"

type BrowserWindowOptionsInput = {
  readonly iconPath: string | null
  readonly preloadPath: string
}

/** Builds the BrowserWindow options that define DiffDash's renderer security boundary. */
export const createDiffDashBrowserWindowOptions = ({
  iconPath,
  preloadPath,
}: BrowserWindowOptionsInput): BrowserWindowConstructorOptions => ({
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
  ...(iconPath === null ? {} : { icon: iconPath }),
  webPreferences: {
    preload: preloadPath,
    sandbox: false,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
  },
})

/** Returns whether a URL may be delegated to the operating system. */
export const isExternalUrlAllowed = (url: string) =>
  url.startsWith("https://") || url.startsWith("http://")

/** Returns whether Electron may complete a renderer navigation without externalizing it. */
export const isInternalNavigationAllowed = (url: string, currentUrl: string) =>
  url === currentUrl || url.startsWith("file://") || url.startsWith("http://localhost:")

/** Normalizes a review path while rejecting explicit parent traversal. */
export const normalizeReviewFilePath = (filePath: string) => {
  const normalized = filePath.replaceAll("\\", "/")
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new Error("Cannot open a file outside the repository checkout")
  }
  return normalized
}

/** Resolves a review path and rejects paths outside the selected repository root. */
export const resolveContainedRepositoryPath = (rootPath: string, filePath: string) => {
  if (isAbsolute(filePath)) {
    throw new Error("Cannot open an absolute file path from a review")
  }

  const resolvedRootPath = resolve(rootPath)
  const targetPath = resolve(resolvedRootPath, normalizeReviewFilePath(filePath))
  const relativePath = relative(resolvedRootPath, targetPath)
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Cannot open a file outside the repository checkout")
  }
  return targetPath
}
