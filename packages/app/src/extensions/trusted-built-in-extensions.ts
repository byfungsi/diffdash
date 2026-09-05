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
import { webNotesExtension } from "./review-comments/web-notes-extension"

/** Trusted renderer extensions synchronously composed at the application root. */
export const trustedBuiltInExtensions: readonly TrustedBuiltInExtension[] = [
  reviewExtension,
  codeExtension,
  walkthroughExtension,
  reviewCommentsExtension,
]

/** Trusted renderer extensions available in a hosted read-only review workspace. */
export const trustedReviewOnlyExtensions: readonly TrustedBuiltInExtension[] = [reviewExtension]

/** Web review workspace with browser-local collected notes and no agent integration. */
export const trustedWebReviewExtensions: readonly TrustedBuiltInExtension[] = [
  reviewExtension,
  webNotesExtension,
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
