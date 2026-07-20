import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import type { BrowserWindowConstructorOptions } from "electron"

type OpenExternal = (url: string) => Promise<void>

/** Minimal renderer frame identity needed to authorize an IPC invocation. */
export interface RendererFrameIdentity {
  readonly url: string
}

/** Minimal WebContents identity needed to authorize an IPC invocation. */
export interface RendererWebContentsIdentity {
  readonly getURL: () => string
  readonly isDestroyed: () => boolean
  readonly mainFrame: RendererFrameIdentity
}

/** Minimal IPC event identity needed to authorize an invocation. */
interface RendererIpcSenderEvent {
  readonly sender: RendererWebContentsIdentity
  readonly senderFrame: RendererFrameIdentity | null
}

/** Canonical renderer trust and external navigation boundary owned by Electron main. */
export interface RendererSecurityPolicy {
  readonly rendererEntryUrl: string
  readonly isRendererNavigationAllowed: (url: string) => boolean
  readonly isTrustedIpcSender: (event: RendererIpcSenderEvent) => boolean
  readonly openExternalUrl: (url: string) => Promise<boolean>
}

type RendererSecurityPolicyInput = {
  readonly developmentRendererUrl: string | undefined
  readonly isPackaged: boolean
  readonly isTrustedWebContents: (webContents: RendererWebContentsIdentity) => boolean
  readonly openExternal: OpenExternal
  readonly packagedRendererUrl: string
}

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

/** Creates the single renderer trust policy shared by window navigation and IPC. */
export const createRendererSecurityPolicy = ({
  developmentRendererUrl,
  isPackaged,
  isTrustedWebContents,
  openExternal,
  packagedRendererUrl,
}: RendererSecurityPolicyInput): RendererSecurityPolicy => {
  const packagedRendererDocument = parseUrl(packagedRendererUrl, "packaged renderer URL")
  if (packagedRendererDocument.protocol !== "file:") {
    throw new Error("Packaged renderer URL must use the file protocol")
  }

  const developmentRenderer =
    isPackaged || developmentRendererUrl === undefined
      ? null
      : parseUrl(developmentRendererUrl, "development renderer URL")
  if (
    developmentRenderer !== null &&
    developmentRenderer.protocol !== "http:" &&
    developmentRenderer.protocol !== "https:"
  ) {
    throw new Error("Development renderer URL must use HTTP or HTTPS")
  }

  const rendererEntry = developmentRenderer ?? packagedRendererDocument
  const isRendererNavigationAllowed = (url: string) => {
    try {
      const candidate = new URL(url)
      return developmentRenderer === null
        ? candidate.href === packagedRendererDocument.href
        : candidate.protocol === developmentRenderer.protocol &&
            candidate.origin === developmentRenderer.origin
    } catch {
      return false
    }
  }

  return {
    rendererEntryUrl: rendererEntry.href,
    isRendererNavigationAllowed,
    isTrustedIpcSender: (event) => {
      const frame = event.senderFrame
      return (
        frame !== null &&
        frame === event.sender.mainFrame &&
        !event.sender.isDestroyed() &&
        isTrustedWebContents(event.sender) &&
        frame.url === event.sender.getURL() &&
        isRendererNavigationAllowed(frame.url)
      )
    },
    openExternalUrl: async (url) => {
      let target: URL
      try {
        target = new URL(url)
      } catch {
        return false
      }
      if (target.protocol !== "http:" && target.protocol !== "https:") return false
      await openExternal(target.href)
      return true
    },
  }
}

/** Creates deny-by-default window handlers backed by the canonical renderer policy. */
export const createRendererNavigationHandlers = (policy: RendererSecurityPolicy) => {
  const openExternalWithoutUnhandledRejection = (url: string) => {
    void policy.openExternalUrl(url).catch(() => undefined)
  }
  const handleNavigation = (event: { readonly preventDefault: () => void }, url: string) => {
    if (policy.isRendererNavigationAllowed(url)) return
    event.preventDefault()
    openExternalWithoutUnhandledRejection(url)
  }

  return {
    handleNavigation,
    handleWindowOpen: (url: string) => {
      openExternalWithoutUnhandledRejection(url)
      return { action: "deny" as const }
    },
  }
}

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

  const resolvedRootPath = realpathSync(resolve(rootPath))
  const targetPath = realpathSync(resolve(resolvedRootPath, normalizeReviewFilePath(filePath)))
  const relativePath = relative(resolvedRootPath, targetPath)
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Cannot open a file outside the repository checkout")
  }
  return targetPath
}

const parseUrl = (url: string, label: string) => {
  try {
    return new URL(url)
  } catch {
    throw new Error(`Invalid ${label}`)
  }
}
