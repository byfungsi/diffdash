/// <reference types="vite/client" />

import type { DemoTimeline } from "@diffdash/demo/demo-api"
import type { DiffDashBridgeApi } from "@diffdash/protocol/api"

declare global {
  interface ImportMetaEnv {
    readonly VITE_APP_VERSION: string
  }

  interface Window {
    readonly diffDash: DiffDashBridgeApi
    readonly __diffDashDemo: DemoTimeline
  }
}
