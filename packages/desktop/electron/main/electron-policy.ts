import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import type { BrowserWindowConstructorOptions } from "electron"
import { OpenRepositoryFilePath } from "@diffdash/protocol/hosted-git"
import { Match } from "effect"
import type { RendererEntry } from "./desktop-host-configuration"

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
  readonly isTrustedWebContents: (webContents: RendererWebContentsIdentity) => boolean
  readonly openExternal: OpenExternal
  readonly rendererEntry: RendererEntry
}

type BrowserWindowOptionsInput = {
  readonly iconPath: string | null
  readonly preloadPath: string
}

/** Builds the BrowserWindow options that define DiffDash's renderer security boundary. */
export const createDiffDashBrowserWindowOptions = ({
  iconPath,
  preloadPath,
}: BrowserWindowOptionsInput): BrowserWindowConstructorOptions => {
  const options: BrowserWindowConstructorOptions = {
    width: 1320,
    height: 860,
    minWidth: 720,
    minHeight: 720,
    title: "DiffDash",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 10, y: 17 },
    show: false,
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
  }
  if (iconPath !== null) options.icon = iconPath
  options.webPreferences = {
    preload: preloadPath,
    sandbox: false,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
  }
  return options
}

/** Creates the single renderer trust policy shared by window navigation and IPC. */
export const createRendererSecurityPolicy = ({
  isTrustedWebContents,
  openExternal,
  rendererEntry,
}: RendererSecurityPolicyInput): RendererSecurityPolicy => {
  const rendererDocument = new URL(rendererEntry.url)
  const isRendererNavigationAllowed = (url: string) => {
    try {
      const candidate = new URL(url)
      return Match.valueTags(rendererEntry, {
        PackagedRendererEntry: () => candidate.href === rendererDocument.href,
        DevelopmentRendererEntry: () =>
          candidate.protocol === rendererDocument.protocol &&
          candidate.origin === rendererDocument.origin,
      })
    } catch {
      return false
    }
  }

  return {
    rendererEntryUrl: rendererDocument.href,
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
export const normalizeReviewFilePath = (filePath: string): OpenRepositoryFilePath => {
  const normalized = filePath.replaceAll("\\", "/")
  if (normalized.length === 0 || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error("Cannot open a file outside the repository checkout")
  }
  return OpenRepositoryFilePath.make(normalized)
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
