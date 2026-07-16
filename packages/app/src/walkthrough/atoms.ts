import { Atom } from "@effect-atom/atom-react"

import { EMPTY_AGENT_PROVIDER_CATALOG } from "@diffdash/protocol/agent-providers"
import { fetchEffect } from "@/shared/effect-api"

/** Registered agent capabilities and models used by walkthrough settings. */
export const agentProviderCatalogAtom = Atom.make(
  fetchEffect(() => window.diffDash.agentProviders.getCatalog()),
  { initialValue: EMPTY_AGENT_PROVIDER_CATALOG },
)
