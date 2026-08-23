import type { TrustedBuiltInExtension } from "./extension-registry"
import { coreWorkspaceExtension } from "./core-workspace/core-workspace-extension"
import { reviewCommentsExtension } from "./review-comments/review-comments-extension"

/** Trusted renderer extensions synchronously composed at the application root. */
export const trustedBuiltInExtensions: readonly TrustedBuiltInExtension[] = [
  coreWorkspaceExtension,
  reviewCommentsExtension,
]
