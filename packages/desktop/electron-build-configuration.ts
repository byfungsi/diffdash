/** Selects the main-process source entrypoint for an explicit electron-vite mode. */
export const desktopMainEntryForMode = (mode: string): string =>
  mode === "e2e" ? "electron/main/index.e2e.ts" : "electron/main/index.ts"
