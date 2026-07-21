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
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: "playwright",
    },
    include: ["src/**/*.browser.test.tsx"],
  },
})
