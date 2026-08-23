import { RegistryProvider } from "@effect/atom-react"

import { TrustedExtensionRegistryProvider } from "@/extensions/extension-registry-context"
import { trustedBuiltInExtensions } from "@/extensions/trusted-built-in-extensions"
import { AppShell } from "@/shell/app-shell"
import { KeyboardShortcutProvider } from "@/shell/keyboard-shortcuts"

/** DiffDash renderer entry point. */
export function App() {
  return (
    <RegistryProvider defaultIdleTTL={400}>
      <KeyboardShortcutProvider>
        <TrustedExtensionRegistryProvider extensions={trustedBuiltInExtensions}>
          <AppShell />
        </TrustedExtensionRegistryProvider>
      </KeyboardShortcutProvider>
    </RegistryProvider>
  )
}
