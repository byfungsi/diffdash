import { describe, expect, it } from "vitest"

import {
  canNavigateHistoryBack,
  canNavigateHistoryForward,
  currentNavigationLocation,
  makeNavigationHistory,
  navigateHistoryBack,
  navigateHistoryForward,
  pushNavigationLocation,
  removeNavigationLocations,
  replaceNavigationLocation,
} from "./app-navigation-history"

const push = (history: ReturnType<typeof makeNavigationHistory<string>>, location: string) =>
  pushNavigationLocation(history, location, (left, right) => left === right)

type FileLocation = { readonly path: string; readonly line: number | null }
const sameFileLocation = (left: FileLocation, right: FileLocation) =>
  left.path === right.path && left.line === right.line

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
    const initial = makeNavigationHistory<FileLocation>({ path: "src/app.ts", line: null })
    const history = pushNavigationLocation(
      initial,
      { path: "src/app.ts", line: 12 },
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
})
