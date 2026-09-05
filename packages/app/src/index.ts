export { App } from "./app"
export { AppErrorBoundary, AppErrorFallback } from "./shared/ui/app-error-boundary"
export { trustedReviewOnlyExtensions } from "./extensions/trusted-built-in-extensions"
export { trustedWebReviewExtensions } from "./extensions/trusted-built-in-extensions"
export { getSystemColorScheme, resolveThemePreference, THEME_DEFINITIONS } from "./settings/theme"
export { TrustedExtensionId, TrustedExtensionContributionId } from "./extensions/extension-registry"
export type { TrustedBuiltInExtension } from "./extensions/extension-registry"
export type { ApplicationLocation, ApplicationNavigation } from "./platform/application-navigation"
export { createDefaultApplicationLocation } from "./platform/application-navigation"
export {
  createReviewApplicationLocation,
  readReviewApplicationLocation,
} from "./extensions/review/review-application-location"
