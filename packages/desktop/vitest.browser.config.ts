import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  worker: {
    format: "es",
  },
  optimizeDeps: {
    include: ["@pierre/diffs/worker/worker.js"],
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve("src/renderer/src"),
    },
  },
  test: {
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: "playwright",
    },
    include: ["src/**/*.browser.test.tsx"],
  },
})
