import { Option } from "effect"
import { describe, expect, it } from "vitest"

import {
  canNavigateHistoryBack,
  canNavigateHistoryForward,
  currentNavigationLocation,
  makeNavigationHistory,
  mapNavigationLocations,
  navigateHistoryBack,
  navigateHistoryBackToAvailable,
  navigateHistoryForward,
  navigateHistoryForwardToAvailable,
  pushNavigationLocation,
  removeNavigationLocations,
  replaceNavigationLocation,
  replaceUnavailableCurrentNavigationLocation,
} from "./app-navigation-history"

const push = (history: ReturnType<typeof makeNavigationHistory<string>>, location: string) =>
  pushNavigationLocation(history, location, (left, right) => left === right)

type FileLocation = { readonly path: string; readonly line: Option.Option<number> }
const sameFileLocation = (left: FileLocation, right: FileLocation) => {
  if (left.path !== right.path) return false
  if (Option.isNone(left.line)) return Option.isNone(right.line)
  if (Option.isNone(right.line)) return false
  return left.line.value === right.line.value
}

describe("app navigation history", () => {
  it("traverses Back and Forward in order", () => {
    const history = push(push(makeNavigationHistory("home"), "review"), "code")
    const review = navigateHistoryBack(history)
    const home = navigateHistoryBack(review)

    expect(currentNavigationLocation(review)).toBe("review")
    expect(currentNavigationLocation(home)).toBe("home")
    expect(canNavigateHistoryBack(home)).toBe(false)
    expect(currentNavigationLocation(navigateHistoryForward(home))).toBe("review")
    expect(canNavigateHistoryForward(history)).toBe(false)
  })

  it("truncates Forward destinations after a new push", () => {
    const history = push(push(makeNavigationHistory("home"), "review"), "code")
    const branched = push(navigateHistoryBack(history), "threads")

    expect(branched.entries).toEqual(["home", "review", "threads"])
    expect(canNavigateHistoryForward(branched)).toBe(false)
  })

  it("replaces duplicate and explicit current destinations without adding entries", () => {
    const history = push(makeNavigationHistory("home"), "review")

    expect(push(history, "review").entries).toEqual(["home", "review"])
    expect(replaceNavigationLocation(history, "files").entries).toEqual(["home", "files"])
  })

  it("keeps distinct locations in the same file", () => {
    const initial = makeNavigationHistory<FileLocation>({
      path: "src/app.ts",
      line: Option.none(),
    })
    const history = pushNavigationLocation(
      initial,
      { path: "src/app.ts", line: Option.some(12) },
      sameFileLocation,
    )

    expect(history.entries).toHaveLength(2)
  })

  it("bounds entries and removes matching destinations", () => {
    let history = makeNavigationHistory("home")
    for (let index = 0; index < 105; index += 1) history = push(history, `project-${index}`)

    expect(history.entries).toHaveLength(100)
    expect(currentNavigationLocation(history)).toBe("project-104")

    const withoutProjects = removeNavigationLocations(history, (entry) => entry.endsWith("-100"))
    expect(withoutProjects.entries).not.toContain("project-100")
    expect(currentNavigationLocation(withoutProjects)).toBe("project-104")
  })

  it("repairs an entirely removed bounded timeline to its required fallback", () => {
    let history = makeNavigationHistory("home")
    for (let index = 0; index < 105; index += 1) history = push(history, `project-${index}`)

    expect(history.entries).not.toContain("home")
    expect(removeNavigationLocations(history, () => true, "home")).toEqual({
      entries: ["home"],
      index: 0,
    })
  })

  it("repairs a timeline whose only owner is unavailable to the required fallback", () => {
    type OwnedLocation = {
      readonly destination: string
      readonly ownerGeneration: number
    }
    const unavailable = { destination: "settings", ownerGeneration: 1 }
    const requiredFallback = { destination: "home", ownerGeneration: 0 }

    expect(
      removeNavigationLocations(
        makeNavigationHistory<OwnedLocation>(unavailable),
        ({ ownerGeneration }) => ownerGeneration === 1,
        requiredFallback,
      ),
    ).toEqual({ entries: [requiredFallback], index: 0 })
  })

  it("repairs destinations without changing history order or cursor", () => {
    const history = navigateHistoryBack(
      push(push(makeNavigationHistory("home"), "removed"), "current"),
    )
    const repaired = mapNavigationLocations(history, (location) =>
      location === "removed" ? "fallback" : location,
    )

    expect(repaired).toEqual({ entries: ["home", "fallback", "current"], index: 1 })
    expect(mapNavigationLocations(repaired, (location) => location)).toBe(repaired)
  })

  it("skips unavailable Back and Forward destinations without decoding them", () => {
    const history = push(push(push(makeNavigationHistory("home"), "stale"), "review"), "code")
    const back = navigateHistoryBackToAvailable(history, (location) => location !== "review")
    const older = navigateHistoryBackToAvailable(back, (location) => location !== "stale")
    const forward = navigateHistoryForwardToAvailable(older, (location) => location !== "stale")

    expect(currentNavigationLocation(back)).toBe("stale")
    expect(currentNavigationLocation(older)).toBe("home")
    expect(currentNavigationLocation(forward)).toBe("review")
  })

  it("retains stale payloads while repairing only the unavailable current location", () => {
    const stalePayload = { owner: 1, payload: "preserve-me" }
    const currentPayload = { owner: 1, payload: "current" }
    const history = pushNavigationLocation(
      pushNavigationLocation(
        makeNavigationHistory({ owner: 0, payload: "home" }),
        stalePayload,
        Object.is,
      ),
      currentPayload,
      Object.is,
    )
    const repaired = replaceUnavailableCurrentNavigationLocation(
      history,
      ({ owner }) => owner === 0,
      () => ({ owner: 0, payload: "fallback" }),
    )

    expect(repaired).toEqual({
      entries: [history.entries[0], stalePayload, { owner: 0, payload: "fallback" }],
      index: 2,
    })
    expect(repaired.entries[1]).toBe(stalePayload)
    expect(
      replaceUnavailableCurrentNavigationLocation(
        repaired,
        () => true,
        () => stalePayload,
      ),
    ).toBe(repaired)
  })
})
