import {
  type OwnedExtensionContribution,
  type ProjectNavigationContribution,
  type ProjectOpeningProviderContribution,
  type TrustedBuiltInExtension,
  TrustedExtensionRegistrationToken,
} from "./extension-registry"
import { codeExtension } from "./code/code-extension"
import { reviewExtension } from "./review/review-extension"
import { reviewCommentsExtension } from "./review-comments/review-comments-extension"
import { walkthroughExtension } from "./walkthrough/walkthrough-extension"

/** Trusted renderer extensions synchronously composed at the application root. */
export const trustedBuiltInExtensions: readonly TrustedBuiltInExtension[] = [
  reviewExtension,
  codeExtension,
  walkthroughExtension,
  reviewCommentsExtension,
]

/** Built-in navigation provider slots retained even when their owner is omitted at cold start. */
export const trustedBuiltInProjectNavigationProviders: readonly OwnedExtensionContribution<ProjectNavigationContribution>[] =
  trustedBuiltInExtensions.flatMap((extension) =>
    (extension.projectNavigation ?? []).map((contribution) => ({
      ...contribution,
      ownerExtensionId: extension.id,
      ownerRegistrationToken: new TrustedExtensionRegistrationToken(),
    })),
  )

/** Built-in project-opening slots retained so live owner removal disposes state in place. */
export const trustedBuiltInProjectOpeningProviders: readonly OwnedExtensionContribution<ProjectOpeningProviderContribution>[] =
  trustedBuiltInExtensions.flatMap((extension) =>
    (extension.projectOpeningProviders ?? []).map((contribution) => ({
      ...contribution,
      ownerExtensionId: extension.id,
      ownerRegistrationToken: new TrustedExtensionRegistrationToken(),
    })),
  )
