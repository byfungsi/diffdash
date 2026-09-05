import { createContext, type ReactNode, useContext } from "react"

/** Host capabilities that change which platform-owned controls the shared renderer can offer. */
export interface ApplicationCapabilities {
  readonly localProjects: boolean
  /** Selects the host-qualified Review viewport without changing contribution policy. */
  readonly reviewViewport: "cards" | "code-view"
}

const DEFAULT_APPLICATION_CAPABILITIES: ApplicationCapabilities = Object.freeze({
  localProjects: true,
  reviewViewport: "cards",
})

const ApplicationCapabilitiesContext = createContext<ApplicationCapabilities>(
  DEFAULT_APPLICATION_CAPABILITIES,
)

/** Provides host capabilities once at the renderer application boundary. */
export function ApplicationCapabilitiesProvider({
  capabilities,
  children,
}: {
  readonly capabilities: ApplicationCapabilities
  readonly children: ReactNode
}) {
  return (
    <ApplicationCapabilitiesContext value={capabilities}>{children}</ApplicationCapabilitiesContext>
  )
}

/** Returns the active renderer host's supported platform capabilities. */
export const useApplicationCapabilities = (): ApplicationCapabilities =>
  useContext(ApplicationCapabilitiesContext)
