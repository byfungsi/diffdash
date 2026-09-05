import cloudflare from "@alchemy.run/cloudflare-runtime/vite"
import { fileURLToPath } from "node:url"
import { createBuilder } from "vite"

// Build both browser assets and the Worker locally, without evaluating deployment state or auth.
const builder = await createBuilder(
  {
    root: fileURLToPath(new URL("../../packages/cloud", import.meta.url)),
    logLevel: "warn",
    plugins: [
      cloudflare({
        main: "worker/index.ts",
        compatibilityDate: "2026-09-05",
      }),
    ],
  },
  null,
)
await builder.buildApp()
