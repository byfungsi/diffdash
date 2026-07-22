import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { defineConfig } from "vite"

const workspaceRoot = resolve(import.meta.dirname, "../..")
const desktopPackage = JSON.parse(
  readFileSync(resolve(workspaceRoot, "packages/desktop/package.json"), "utf8"),
) as { readonly version: string }

export default defineConfig({
  root: import.meta.dirname,
  worker: { format: "es" },
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(`v${desktopPackage.version}`),
  },
  resolve: {
    alias: { "@": resolve(workspaceRoot, "packages/app/src") },
  },
  plugins: [react(), tailwindcss()],
  server: { fs: { allow: [workspaceRoot] } },
  build: {
    outDir: resolve(import.meta.dirname, ".cache/host"),
    emptyOutDir: true,
  },
})
