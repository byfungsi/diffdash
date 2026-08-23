import { Result } from "effect"
import { createContext, type ReactNode, use, useState, useSyncExternalStore } from "react"

import {
  type TrustedBuiltInExtension,
  makeTrustedExtensionRegistry,
  type TrustedExtensionRegistry,
  type TrustedExtensionRegistrySnapshot,
} from "./extension-registry"

const TrustedExtensionRegistryContext = createContext<TrustedExtensionRegistry | null>(null)

/** Composes statically trusted renderer extensions once and exposes their immutable registry. */
export const TrustedExtensionRegistryProvider = ({
  children,
  extensions,
}: {
  readonly children: ReactNode
  readonly extensions: readonly TrustedBuiltInExtension[]
}) => {
  const [registry] = useState(() => {
    const composed = makeTrustedExtensionRegistry(extensions)
    if (Result.isFailure(composed)) throw composed.failure
    return composed.success
  })

  return (
    <TrustedExtensionRegistryContext value={registry}>{children}</TrustedExtensionRegistryContext>
  )
}

/** Returns the current trusted extension snapshot and subscribes to ownership changes. */
export const useTrustedExtensionRegistry = (): TrustedExtensionRegistrySnapshot => {
  const registry = use(TrustedExtensionRegistryContext)
  if (registry === null) throw new Error("TrustedExtensionRegistryProvider is unavailable")
  return useSyncExternalStore(registry.subscribe, registry.snapshot, registry.snapshot)
}
