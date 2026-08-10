import "./load-local-env.mjs"
import { parseVerifyReleaseArguments } from "./release-arguments.mjs"
import { requiredEnvironment } from "./release-environment.mjs"
import { deriveReleaseContext } from "./release-context.mjs"
import { verifyPublicRelease } from "./release-verification.mjs"

const cli = parseVerifyReleaseArguments()
const context = deriveReleaseContext({
  requestedTag: cli.tag,
  commitRef: false,
  publicOrigin: cli.baseUrl ?? requiredEnvironment("R2_PUBLIC_BASE_URL"),
})

await verifyPublicRelease({ tag: context.tag, baseUrl: context.publicOrigin })
