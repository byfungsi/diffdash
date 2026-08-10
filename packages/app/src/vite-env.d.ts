/// <reference types="vite/client" />

import type { DiffDashBridgeApi } from "@diffdash/protocol/api"

declare global {
  interface ImportMetaEnv {
    readonly VITE_APP_VERSION: string
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }

  interface Window {
    readonly diffDash: DiffDashBridgeApi
  }
}
