import { RegistryProvider } from "@effect-atom/atom-react"

import { AppShell } from "@/shell/app-shell"

/** DiffDash renderer entry point. */
export function App() {
  return (
    <RegistryProvider defaultIdleTTL={400}>
      <AppShell />
    </RegistryProvider>
  )
}
