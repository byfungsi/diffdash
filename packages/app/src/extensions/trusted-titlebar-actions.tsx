import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import { createElement } from "react"

import type {
  OwnedExtensionContribution,
  TrustedTitlebarActionContribution,
} from "./extension-registry"

/** Renders ordered trusted titlebar actions with renderer-owned project context. */
export const TrustedTitlebarActions = ({
  actions,
  projectId,
}: {
  readonly actions: readonly OwnedExtensionContribution<TrustedTitlebarActionContribution>[]
  readonly projectId: ReviewProjectId | null
}) =>
  actions.map((action) =>
    createElement(action.component, {
      key: `${action.ownerExtensionId}:${action.id}:${action.ownerRegistrationToken.reactKey}`,
      projectId,
    }),
  )
