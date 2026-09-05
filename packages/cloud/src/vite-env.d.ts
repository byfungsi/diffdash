/// <reference types="vite/client" />

import type { DiffDashBridgeApi } from "@diffdash/protocol/api"

declare global {
  interface Window {
    readonly diffDash: DiffDashBridgeApi
  }
}

export {}
