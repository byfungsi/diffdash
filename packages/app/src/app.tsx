import { RegistryProvider } from "@effect/atom-react"

import { AppShell } from "@/shell/app-shell"
import { KeyboardShortcutProvider } from "@/shell/keyboard-shortcuts"

/** DiffDash renderer entry point. */
export function App() {
  return (
    <RegistryProvider defaultIdleTTL={400}>
      <KeyboardShortcutProvider>
        <AppShell />
      </KeyboardShortcutProvider>
    </RegistryProvider>
  )
}
