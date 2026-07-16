import { Atom } from "@effect-atom/atom-react"

import { EMPTY_APP_PREREQUISITES } from "@diffdash/protocol/prerequisites"
import { fetchEffect } from "@/shared/effect-api"

/** Current local setup diagnostics used by onboarding and Home. */
export const diagnosticsAtom = Atom.make(
  fetchEffect(() => window.diffDash.diagnostics()),
  {
    initialValue: EMPTY_APP_PREREQUISITES,
  },
).pipe(Atom.keepAlive)
