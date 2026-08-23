import type { TrustedBuiltInExtension } from "./extension-registry"
import { reviewCommentsExtension } from "./review-comments/review-comments-extension"

/** Trusted renderer extensions synchronously composed at the application root. */
export const trustedBuiltInExtensions: readonly TrustedBuiltInExtension[] = [
  reviewCommentsExtension,
]
