import { Effect } from "effect"
import { Atom } from "effect/unstable/reactivity"

import { EMPTY_APP_PREREQUISITES } from "@diffdash/protocol/prerequisites"
import { DesktopRuntime } from "@/platform/desktop-runtime"
import { rendererRuntime } from "@/platform/renderer-runtime"

/** Current local setup diagnostics used by onboarding and Home. */
export const diagnosticsAtom = rendererRuntime
  .atom(
    Effect.gen(function* () {
      const desktop = yield* DesktopRuntime
      return yield* desktop.getDiagnostics()
    }),
    {
      initialValue: EMPTY_APP_PREREQUISITES,
    },
  )
  .pipe(Atom.keepAlive)
