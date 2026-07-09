/// <reference types="vite/client" />

import type { DiffDashApi } from "../../../electron/preload"

declare global {
  interface Window {
    readonly diffDash: DiffDashApi
  }
}
