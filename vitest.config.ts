import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve("src/renderer/src"),
    },
  },
  test: {
    exclude: ["src/**/*.browser.test.tsx"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "electron/**/*.test.ts"],
    pool: "forks",
  },
})
