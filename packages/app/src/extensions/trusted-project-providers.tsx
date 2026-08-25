import { HashMap, HashSet } from "effect"
import type { ReactNode } from "react"
import { useRef } from "react"

import type {
  OwnedExtensionContribution,
  TrustedProjectProviderContribution,
  TrustedProjectProviderProps,
} from "./extension-registry"

/** Composes ordered trusted extension state providers around the active workbench. */
export const TrustedProjectProviders = ({
  children,
  directory,
  projectId,
  providers,
}: Omit<TrustedProjectProviderProps, "active" | "registrationToken"> & {
  readonly providers: readonly OwnedExtensionContribution<TrustedProjectProviderContribution>[]
}) => {
  const knownProvidersRef = useRef(
    HashMap.fromIterable(providers.map((provider) => [provider.id, provider])),
  )
  for (const provider of providers) {
    knownProvidersRef.current = HashMap.set(knownProvidersRef.current, provider.id, provider)
  }
  const activeProviderIds = HashSet.fromIterable(providers.map(({ id }) => id))
  return Array.from(knownProvidersRef.current, ([, provider]) => provider)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .reduceRight<ReactNode>((content, provider) => {
      const Provider = provider.component
      return (
        <Provider
          key={`${provider.ownerExtensionId}:${provider.id}:${provider.ownerRegistrationToken.reactKey}`}
          active={HashSet.has(activeProviderIds, provider.id)}
          directory={directory}
          projectId={projectId}
          registrationToken={provider.ownerRegistrationToken}
        >
          {content}
        </Provider>
      )
    }, children)
}
