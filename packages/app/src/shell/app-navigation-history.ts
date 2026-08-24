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

/** Moves to the previous destination when one exists. */
export const navigateHistoryBack = <Location>(
  history: NavigationHistory<Location>,
): NavigationHistory<Location> =>
  canNavigateHistoryBack(history) ? { ...history, index: history.index - 1 } : history

/** Moves to the next destination when one exists. */
export const navigateHistoryForward = <Location>(
  history: NavigationHistory<Location>,
): NavigationHistory<Location> =>
  canNavigateHistoryForward(history) ? { ...history, index: history.index + 1 } : history

/** Removes destinations matching a predicate while retaining a valid active entry. */
export const removeNavigationLocations = <Location>(
  history: NavigationHistory<Location>,
  shouldRemove: (location: Location) => boolean,
): NavigationHistory<Location> => {
  const entries = history.entries.filter((entry) => !shouldRemove(entry))
  if (entries.length === 0) return history
  const removedThroughCurrent = history.entries
    .slice(0, history.index + 1)
    .filter(shouldRemove).length
  return {
    entries,
    index: Math.min(entries.length - 1, Math.max(0, history.index - removedThroughCurrent)),
  }
}
