import { readFileSync } from "node:fs"
import "./load-local-env.mjs"
import { parseVerifyReleaseArguments } from "./release-arguments.mjs"
import { requiredEnvironment } from "./release-environment.mjs"
import { releaseTagForVersion } from "./release-policy.mjs"
import { verifyPublicRelease } from "./release-verification.mjs"

const cli = parseVerifyReleaseArguments()
const packageJson = JSON.parse(readFileSync("packages/desktop/package.json", "utf8"))
const tag = cli.tag ?? releaseTagForVersion(packageJson.version)
const baseUrl = cli.baseUrl ?? requiredEnvironment("R2_PUBLIC_BASE_URL")

await verifyPublicRelease({ tag, baseUrl })
