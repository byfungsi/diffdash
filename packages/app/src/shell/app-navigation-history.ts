import { Option } from "effect"

/** Immutable bounded navigation timeline with one active entry. */
export interface NavigationHistory<Location> {
  readonly entries: readonly Location[]
  readonly index: number
}

const DEFAULT_NAVIGATION_HISTORY_LIMIT = 100

/** Creates a navigation timeline at its initial destination. */
export const makeNavigationHistory = <Location>(
  initial: Location,
): NavigationHistory<Location> => ({ entries: [initial], index: 0 })

/** Returns the active destination. */
export const currentNavigationLocation = <Location>(
  history: NavigationHistory<Location>,
): Location => {
  const location = history.entries[history.index] ?? history.entries[0]
  if (location === undefined) throw new Error("Navigation history must contain a destination")
  return location
}

/** Returns whether an older destination is available. */
export const canNavigateHistoryBack = <Location>(history: NavigationHistory<Location>): boolean =>
  history.index > 0

/** Returns whether a newer destination is available. */
export const canNavigateHistoryForward = <Location>(
  history: NavigationHistory<Location>,
): boolean => history.index < history.entries.length - 1

/** Pushes a destination, dropping the Forward branch and oldest entries above the bound. */
export const pushNavigationLocation = <Location>(
  history: NavigationHistory<Location>,
  location: Location,
  isSame: (left: Location, right: Location) => boolean,
  limit = DEFAULT_NAVIGATION_HISTORY_LIMIT,
): NavigationHistory<Location> => {
  if (isSame(currentNavigationLocation(history), location)) {
    return replaceNavigationLocation(history, location)
  }
  const appended = [...history.entries.slice(0, history.index + 1), location]
  const entries = appended.slice(Math.max(0, appended.length - limit))
  return { entries, index: entries.length - 1 }
}

/** Replaces the active destination without changing traversal order. */
export const replaceNavigationLocation = <Location>(
  history: NavigationHistory<Location>,
  location: Location,
): NavigationHistory<Location> => ({
  entries: history.entries.map((entry, index) => (index === history.index ? location : entry)),
  index: history.index,
})

/** Repairs only an unavailable active destination while retaining stale traversal entries. */
export const replaceUnavailableCurrentNavigationLocation = <Location>(
  history: NavigationHistory<Location>,
  isAvailable: (location: Location) => boolean,
  replacement: (unavailable: Location) => Location,
): NavigationHistory<Location> => {
  const current = currentNavigationLocation(history)
  return isAvailable(current) ? history : replaceNavigationLocation(history, replacement(current))
}

/** Moves to the previous destination when one exists. */
export const navigateHistoryBack = <Location>(
  history: NavigationHistory<Location>,
): NavigationHistory<Location> => {
  if (!canNavigateHistoryBack(history)) return history
  return { ...history, index: history.index - 1 }
}

/** Moves to the next destination when one exists. */
export const navigateHistoryForward = <Location>(
  history: NavigationHistory<Location>,
): NavigationHistory<Location> => {
  if (!canNavigateHistoryForward(history)) return history
  return { ...history, index: history.index + 1 }
}

/** Moves Back to the nearest currently available destination, skipping stale owners. */
export const navigateHistoryBackToAvailable = <Location>(
  history: NavigationHistory<Location>,
  isAvailable: (location: Location) => boolean,
): NavigationHistory<Location> => {
  for (let index = history.index - 1; index >= 0; index -= 1) {
    const location = history.entries[index]
    if (location !== undefined && isAvailable(location)) return { entries: history.entries, index }
  }
  return history
}

/** Moves Forward to the nearest currently available destination, skipping stale owners. */
export const navigateHistoryForwardToAvailable = <Location>(
  history: NavigationHistory<Location>,
  isAvailable: (location: Location) => boolean,
): NavigationHistory<Location> => {
  for (let index = history.index + 1; index < history.entries.length; index += 1) {
    const location = history.entries[index]
    if (location !== undefined && isAvailable(location)) return { entries: history.entries, index }
  }
  return history
}

/** Removes destinations matching a predicate while retaining a valid active entry. */
export const removeNavigationLocations = <Location>(
  history: NavigationHistory<Location>,
  shouldRemove: (location: Location) => boolean,
  fallback?: Location,
): NavigationHistory<Location> => {
  const entries = history.entries.filter((entry) => !shouldRemove(entry))
  if (entries.length === 0) {
    const fallbackOption = Option.fromNullishOr(fallback)
    if (Option.isNone(fallbackOption)) return history
    return makeNavigationHistory(fallbackOption.value)
  }
  const removedThroughCurrent = history.entries
    .slice(0, history.index + 1)
    .filter(shouldRemove).length
  return {
    entries,
    index: Math.min(entries.length - 1, Math.max(0, history.index - removedThroughCurrent)),
  }
}

/** Rewrites navigation destinations while preserving their order and active cursor. */
export const mapNavigationLocations = <Location>(
  history: NavigationHistory<Location>,
  mapLocation: (location: Location) => Location,
): NavigationHistory<Location> => {
  let changed = false
  const entries = history.entries.map((location) => {
    const mapped = mapLocation(location)
    if (mapped !== location) changed = true
    return mapped
  })
  if (!changed) return history
  return { entries, index: history.index }
}
