import { playwright } from "@vitest/browser-playwright"
import { defineConfig, mergeConfig } from "vitest/config"
import viteConfig from "./vite.config"

export default defineConfig((environment) =>
  mergeConfig(
    viteConfig(environment),
    defineConfig({
      define: {
        "import.meta.env.VITE_POSTHOG_KEY": JSON.stringify(""),
        "import.meta.env.VITE_POSTHOG_HOST": JSON.stringify(""),
      },
      worker: { format: "es" },
      test: {
        fileParallelism: false,
        // Cold module workers on CI can take longer than Vitest's one-second
        // polling default. Rendering budgets remain explicit in their tests.
        expect: { poll: { timeout: 5_000 } },
        browser: {
          enabled: true,
          headless: true,
          provider: playwright({
            contextOptions: { permissions: ["clipboard-read", "clipboard-write"] },
          }),
          instances: [{ browser: "chromium" }],
        },
        include: ["src/**/*.browser.test.tsx"],
      },
    }),
  ),
)
