import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"
import { defineConfig } from "vite"

const workspaceRoot = resolve(import.meta.dirname, "../..")

export default defineConfig({
  root: import.meta.dirname,
  worker: {
    format: "es",
  },
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify("v0.2.1"),
  },
  resolve: {
    alias: {
      "@": resolve(workspaceRoot, "packages/desktop/src/renderer/src"),
    },
  },
  plugins: [react(), tailwindcss()],
  server: {
    fs: {
      allow: [workspaceRoot],
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, ".cache/host"),
    emptyOutDir: true,
  },
})
