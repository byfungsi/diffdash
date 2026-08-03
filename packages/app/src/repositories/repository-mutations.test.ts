import { describe, expect, it, vi } from "vitest"
import {
  type RepositoryMutationKind,
  type RepositoryQueryInvalidations,
  runRepositoryMutation,
} from "./repository-mutations"

const makeInvalidations = () =>
  ({
    repositories: vi.fn<() => void>(),
    localSearch: vi.fn<() => void>(),
    remoteSearch: vi.fn<() => void>(),
    selectedReviews: vi.fn<() => void>(),
  }) satisfies RepositoryQueryInvalidations

const expectedTargets: Record<
  RepositoryMutationKind,
  readonly (keyof RepositoryQueryInvalidations)[]
> = {
  favorite: ["repositories", "localSearch", "remoteSearch"],
  rememberRemote: ["repositories", "localSearch", "remoteSearch"],
  setFavorite: ["repositories", "localSearch", "remoteSearch"],
  install: ["repositories", "localSearch"],
  link: ["repositories", "localSearch"],
  forget: ["repositories", "localSearch", "remoteSearch", "selectedReviews"],
}
const mutationKinds = [
  "favorite",
  "rememberRemote",
  "setFavorite",
  "install",
  "link",
  "forget",
] as const
const invalidationTargets = [
  "repositories",
  "localSearch",
  "remoteSearch",
  "selectedReviews",
] as const

describe("repository mutation invalidation", () => {
  it.each(mutationKinds)("invalidates each intended %s dependency once", async (kind) => {
    const invalidations = makeInvalidations()
    await expect(runRepositoryMutation(kind, async () => "saved", invalidations)).resolves.toBe(
      "saved",
    )

    const expected = new Set(expectedTargets[kind])
    invalidationTargets.forEach((target) => {
      expect(invalidations[target]).toHaveBeenCalledTimes(expected.has(target) ? 1 : 0)
    })
  })

  it("does not invalidate queries after a rejected repository mutation", async () => {
    const invalidations = makeInvalidations()
    await expect(
      runRepositoryMutation(
        "link",
        async () => {
          throw new Error("link failed")
        },
        invalidations,
      ),
    ).rejects.toThrow("link failed")

    Object.values(invalidations).forEach((invalidate) => expect(invalidate).not.toHaveBeenCalled())
  })
})
