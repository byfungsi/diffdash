import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"
import { defineConfig, loadEnv } from "vite"

export default defineConfig(({ mode }) => {
  const cloudEnv = loadEnv(mode, import.meta.dirname, "VITE_POSTHOG_")
  const rootEnv = loadEnv(mode, resolve(import.meta.dirname, "../.."), "VITE_POSTHOG_")
  const landingEnv = loadEnv(mode, resolve(import.meta.dirname, "../web"), "VITE_POSTHOG_")
  return {
    server: {
      proxy: {
        "^/api/public-pull-diff/[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+/[1-9][0-9]*$": {
          target: "https://patch-diff.githubusercontent.com",
          changeOrigin: true,
          rewrite: (path) =>
            path.replace(
              /^\/api\/public-pull-diff\/([^/]+)\/([^/]+)\/([0-9]+)$/,
              "/raw/$1/$2/pull/$3.diff",
            ),
          configure: (proxy) => {
            proxy.on("proxyReq", (request) => {
              request.removeHeader("authorization")
              request.removeHeader("cookie")
              request.removeHeader("referer")
            })
          },
        },
      },
    },
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify("Cloud v0"),
      "import.meta.env.VITE_POSTHOG_KEY": JSON.stringify(
        cloudEnv.VITE_POSTHOG_KEY || rootEnv.VITE_POSTHOG_KEY || landingEnv.VITE_POSTHOG_KEY || "",
      ),
      "import.meta.env.VITE_POSTHOG_HOST": JSON.stringify(
        cloudEnv.VITE_POSTHOG_HOST ||
          rootEnv.VITE_POSTHOG_HOST ||
          landingEnv.VITE_POSTHOG_HOST ||
          "",
      ),
    },
    resolve: {
      alias: {
        "@": resolve(import.meta.dirname, "../app/src"),
      },
    },
    plugins: [react(), tailwindcss()],
  }
})
