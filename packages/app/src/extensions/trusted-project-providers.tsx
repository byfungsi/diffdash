import type { ReactNode } from "react"

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
}: TrustedProjectProviderProps & {
  readonly providers: readonly OwnedExtensionContribution<TrustedProjectProviderContribution>[]
}) =>
  providers.reduceRight<ReactNode>((content, provider) => {
    const Provider = provider.component
    return (
      <Provider
        key={`${provider.ownerExtensionId}:${provider.id}`}
        directory={directory}
        projectId={projectId}
      >
        {content}
      </Provider>
    )
  }, children)
