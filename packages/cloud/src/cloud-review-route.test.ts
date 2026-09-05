import { describe, expect, it } from "vitest"
import {
  CloudReviewRouteError,
  formatCloudReviewRoute,
  parseCloudReviewRoute,
} from "./cloud-review-route"

describe("GitHub-compatible review routes", () => {
  it.each([
    "/",
    "/byfungsi/diffdash/pulls",
    "/byfungsi/diffdash/pull/1",
    "/byfungsi/diffdash/pull/1/files",
    "/byfungsi/diffdash/commit/abcdef1234567",
    "/byfungsi/diffdash/compare/main...feature%2Freview",
  ])("round trips %s", (path) => {
    expect(formatCloudReviewRoute(parseCloudReviewRoute(path))).toBe(path)
  })
  it("keeps slash refs and treats repository landing URLs as PR lists", () => {
    expect(
      parseCloudReviewRoute("/byfungsi/diffdash/compare/release/v1...feature/review"),
    ).toMatchObject({ base: "release/v1", head: "feature/review" })
    expect(parseCloudReviewRoute("/byfungsi/diffdash/")).toMatchObject({ kind: "repository" })
  })
  it.each([
    "/pull/diffdash/1",
    "/byfungsi/diffdash/pull/0",
    "/byfungsi/diffdash/pull/9007199254740992",
    "/byfungsi/diffdash/pull/1/commits",
    "/byfungsi/diffdash/issues/1",
    "/byfungsi/diffdash/compare/main..head",
    "/byfungsi/diffdash/compare/...head",
    "/byfungsi/diffdash/compare/main...",
    "/byfungsi/diffdash/commit/not-a-sha",
    "/byfungsi%2Fother/diffdash/pull/1",
    "/byfungsi/diffdash/compare/%ZZ...main",
    "/byfungsi/diffdash/compare/main...fork:branch",
  ])("rejects invalid or deferred route %s", (path) => {
    expect(() => parseCloudReviewRoute(path)).toThrow(CloudReviewRouteError)
  })
})
