/// <reference types="vite/client" />

import type { DemoTimeline } from "@diffdash/demo/demo-api"
import type { DiffDashApi } from "../../../packages/desktop/src/shared/diffdash-api"

declare global {
  interface ImportMetaEnv {
    readonly VITE_APP_VERSION: string
  }

  interface Window {
    readonly diffDash: DiffDashApi
    readonly __diffDashDemo: DemoTimeline
  }
}
