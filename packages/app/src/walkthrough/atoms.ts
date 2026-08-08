import { Effect } from "effect"

import { EMPTY_AGENT_PROVIDER_CATALOG } from "@diffdash/protocol/agent-providers"
import { rendererRuntime } from "@/platform/renderer-runtime"
import { ReviewAutomation } from "@/platform/review-automation"

/** Registered agent capabilities and models used by walkthrough settings. */
export const agentProviderCatalogAtom = rendererRuntime.atom(
  Effect.gen(function* () {
    const automation = yield* ReviewAutomation
    return yield* automation.getAgentCatalog()
  }),
  { initialValue: EMPTY_AGENT_PROVIDER_CATALOG },
)
