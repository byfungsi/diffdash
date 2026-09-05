import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import { fileURLToPath } from "node:url"

/** Cloud infrastructure uses Fungsi's Alchemy version in a separate deployment runtime. */
export default Alchemy.Stack(
  "diffdash-cloud",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const website = yield* Cloudflare.Website.Vite("diffdash-cloud", {
      rootDir: fileURLToPath(new URL("../../packages/cloud", import.meta.url)),
      main: "worker/index.ts",
      name: "diffdash-cloud",
      domain: "cloud.usediffdash.com",
      workersDev: false,
      compatibility: { date: "2026-09-05" },
      assets: {
        runWorkerFirst: true,
        notFoundHandling: "single-page-application",
      },
      memo: {
        include: ["**/*", "../app/src/**", "../domain/src/**", "../protocol/src/**"],
        lockfile: true,
      },
    })
    return { url: website.url }
  }),
)
