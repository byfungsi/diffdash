import { RegistryProvider } from "@effect/atom-react"

import { TrustedExtensionRegistryProvider } from "@/extensions/extension-registry-context"
import { ProjectNavigationRuntimeProvider } from "@/extensions/project-navigation-runtime"
import {
  trustedBuiltInExtensions,
  trustedBuiltInProjectOpeningProviders,
} from "@/extensions/trusted-built-in-extensions"
import type {
  TrustedBuiltInExtension,
  TrustedExtensionRegistry,
} from "@/extensions/extension-registry"
import { AppShell } from "@/shell/app-shell"
import { RegisteredProjectOpeningProviders } from "@/extensions/project-opening-runtime"
import { KeyboardShortcutProvider } from "@/shell/keyboard-shortcuts"
import { SettingsMutationProvider } from "@/settings/use-settings-mutation"
import { ProjectWorkspacePersistenceProvider } from "@/extensions/project-workspace-persistence"

/** DiffDash renderer entry point. */
export function App({
  extensions = trustedBuiltInExtensions,
  registry,
}: {
  readonly extensions?: readonly TrustedBuiltInExtension[]
  readonly registry?: TrustedExtensionRegistry
}) {
  return (
    <RegistryProvider defaultIdleTTL={400}>
      <KeyboardShortcutProvider>
        <SettingsMutationProvider>
          <ProjectWorkspacePersistenceProvider>
            <TrustedExtensionRegistryProvider extensions={extensions} registry={registry}>
              <ProjectNavigationRuntimeProvider>
                <RegisteredProjectOpeningProviders
                  knownProviders={trustedBuiltInProjectOpeningProviders}
                >
                  <AppShell />
                </RegisteredProjectOpeningProviders>
              </ProjectNavigationRuntimeProvider>
            </TrustedExtensionRegistryProvider>
          </ProjectWorkspacePersistenceProvider>
        </SettingsMutationProvider>
      </KeyboardShortcutProvider>
    </RegistryProvider>
  )
}
