/** Minimum Electron window operations needed to reveal an existing app window. */
export interface ActivatableWindow {
  readonly isMinimized: () => boolean
  readonly restore: () => void
  readonly show: () => void
  readonly focus: () => void
}

/** Restores and reveals a window using the platform's foreground-focus behavior. */
export const revealAppWindow = (
  targetWindow: ActivatableWindow,
  options: {
    readonly hidden: boolean
    readonly platform: NodeJS.Platform
    readonly focusApplication: () => void
  },
) => {
  if (options.hidden) return
  if (targetWindow.isMinimized()) targetWindow.restore()
  targetWindow.show()
  if (options.platform === "darwin") options.focusApplication()
  else targetWindow.focus()
}
