/// <reference types="vite/client" />

import type { DiffDashApi } from "../../../electron/preload"

declare global {
  interface ImportMetaEnv {
    readonly VITE_APP_VERSION: string
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }

  interface Window {
    readonly diffDash: DiffDashApi
  }
}
