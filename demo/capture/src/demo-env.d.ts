/// <reference types="vite/client" />

import type { DemoTimeline } from "../../../src/demo/demo-api"
import type { DiffDashApi } from "../../../src/shared/diffdash-api"

declare global {
  interface ImportMetaEnv {
    readonly VITE_APP_VERSION: string
  }

  interface Window {
    readonly diffDash: DiffDashApi
    readonly __diffDashDemo: DemoTimeline
  }
}
