import { CoreMethod } from "@diffdash/core"
import { InvokeChannel } from "@diffdash/protocol/channels"
import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import { transportError } from "@diffdash/protocol/transport-error"
import { app, BrowserWindow, shell } from "electron"
import { isAbsolute } from "node:path"
import type { ApplicationRuntime } from "../../application-runtime"
import { normalizeReviewFilePath } from "../../electron-policy"
import type { RendererSecurityPolicy } from "../../electron-policy"
import { openLocalPath } from "../../file-opening"
import { openCoreFileIntent } from "../core-file-open-intent"
import { isHiddenE2EWindow, revealAppWindow } from "../../window-activation"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines navigation IPC handler implementations. */
export const defineNavigationHandlers = (
  runtime: ApplicationRuntime,
  handlers: IpcControllerRegistry,
  navigationCommands: {
    readonly peek: () => readonly CliNavigationCommand[]
    readonly acknowledge: (count: number) => void
  },
  rendererSecurityPolicy: RendererSecurityPolicy,
) => {
  const openIntent = (intent: Parameters<typeof openCoreFileIntent>[0]): Promise<void> =>
    openCoreFileIntent(intent, {
      openExternal: (url) => rendererSecurityPolicy.openExternalUrl(url),
      openLocal: (targetPath) => openLocalPath((path) => shell.openPath(path), targetPath),
    })

  handlers.define(InvokeChannel.appActivateWindow, async (event): Promise<void> => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender)
    if (targetWindow === null)
      throw transportError("WINDOW_UNAVAILABLE", "DiffDash window is unavailable.")
    revealAppWindow(targetWindow, {
      hidden: isHiddenE2EWindow(),
      platform: process.platform,
      focusApplication: () => app.focus({ steal: true }),
    })
  })

  handlers.defineTransactional(InvokeChannel.drainNavigationCommands, async () => {
    const commands = navigationCommands.peek()
    return {
      response: commands,
      commit: () => navigationCommands.acknowledge(commands.length),
    }
  })

  handlers.define(InvokeChannel.appOpenExternalUrl, async (_event, { url }): Promise<void> => {
    await rendererSecurityPolicy.openExternalUrl(url)
  })

  handlers.define(InvokeChannel.appOpenRepositoryFile, async (_event, request): Promise<void> => {
    if (isAbsolute(request.filePath)) {
      throw transportError(
        "INVALID_REVIEW_FILE_PATH",
        "Cannot open an absolute file path from a review.",
      )
    }

    const normalizedFilePath = normalizeReviewFilePath(request.filePath)
    const intent = await runtime.execute(CoreMethod.appOpenRepositoryFile, {
      ...request,
      filePath: normalizedFilePath,
    })
    await openIntent(intent)
  })

  handlers.define(
    InvokeChannel.appOpenRepositoryComparisonFile,
    async (_event, { target, filePath }): Promise<void> => {
      if (isAbsolute(filePath)) {
        throw transportError(
          "INVALID_REVIEW_FILE_PATH",
          "Cannot open an absolute file path from a review.",
        )
      }
      const intent = await runtime.execute(CoreMethod.appOpenRepositoryComparisonFile, {
        target,
        filePath: normalizeReviewFilePath(filePath),
      })
      await openIntent(intent)
    },
  )

  handlers.define(
    InvokeChannel.appOpenLocalRepositoryFile,
    async (_event, { rootPath, filePath }): Promise<void> => {
      const intent = await runtime.execute(CoreMethod.appOpenLocalRepositoryFile, {
        rootPath,
        filePath: normalizeReviewFilePath(filePath),
      })
      await openIntent(intent)
    },
  )
}
