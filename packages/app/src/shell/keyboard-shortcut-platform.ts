/** Returns whether shortcut labels should use the macOS Command modifier. */
export const isMacPlatform = (platform = window.navigator.platform): boolean =>
  /Mac|iPhone|iPad|iPod/i.test(platform)

/** Returns the platform-appropriate primary shortcut modifier label. */
export const keyboardShortcutModifierLabel = (): "Cmd" | "Ctrl" =>
  isMacPlatform() ? "Cmd" : "Ctrl"
