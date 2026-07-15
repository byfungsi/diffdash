import { Schema } from "effect"

/** Persisted app-level state that is independent from user-configurable settings. */
export class AppState extends Schema.Class<AppState>("AppState")({
  onboardingCompleted: Schema.Boolean,
}) {}

/** Default app state for a fresh DiffDash install. */
export const DEFAULT_APP_STATE = AppState.make({
  onboardingCompleted: false,
})
