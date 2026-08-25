import { ProjectHeadCodeWorkspaceTarget } from "@diffdash/domain/code-workspace"
import { CodeLineChangeRange } from "@diffdash/domain/code-line-change"
import {
  LanguagePosition,
  LanguageRange,
  RepositoryLanguageLocation,
  RepositoryLanguageLocationLink,
} from "@diffdash/domain/language"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { HashMap, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  codeNavigationContribution,
  decodeCodeNavigationState,
  encodeCodeNavigationState,
  navigateCodeNavigationDefinition,
  restoreCodeNavigationState,
  selectCodeNavigationPath,
} from "./code-navigation"

const projectId = ReviewProjectId.make("github:fungsi/diffdash")
const sourcePath = RepositoryRelativePath.make("src/source.ts")
const targetPath = RepositoryRelativePath.make("src/target.ts")
const range = LanguageRange.make({
  start: LanguagePosition.make({ line: 2, character: 1 }),
  end: LanguagePosition.make({ line: 2, character: 5 }),
})

const encodedCodeState = () =>
  encodeCodeNavigationState({
    target: ProjectHeadCodeWorkspaceTarget.make({ projectId }),
    path: Option.some(sourcePath),
    revealRange: Option.none(),
    fileStatuses: HashMap.make([sourcePath, "modified" as const]),
    lineChanges: HashMap.fromIterable([
      [sourcePath, [CodeLineChangeRange.make({ kind: "modified", startLine: 3, endLine: 4 })]],
    ]),
  })

describe("Code navigation contribution", () => {
  it("round-trips structured-clone-safe Code state and restores runtime collections", () => {
    const encoded = encodedCodeState()
    const cloned = Schema.decodeUnknownSync(Schema.Json)(structuredClone(encoded))
    let restoredPath = Option.none<RepositoryRelativePath>()

    expect(encoded).toMatchObject({
      path: sourcePath,
      revealRange: null,
      fileStatuses: [[sourcePath, "modified"]],
    })
    expect(encoded).not.toHaveProperty("selectedReview")

    restoreCodeNavigationState(cloned, {
      restore: (state) => {
        restoredPath = state.path
        expect(HashMap.get(state.fileStatuses, sourcePath)).toEqual(Option.some("modified"))
        expect(HashMap.get(state.lineChanges, sourcePath)).toEqual(
          Option.some([expect.objectContaining({ startLine: 3, endLine: 4 })]),
        )
      },
    })

    expect(restoredPath).toEqual(Option.some(sourcePath))
    expect(codeNavigationContribution.isValidState(cloned)).toBe(true)
  })

  it("owns path and definition mutations while ignoring refreshed status metadata in equality", () => {
    const selected = selectCodeNavigationPath(encodedCodeState(), Option.some(targetPath))
    const definition = navigateCodeNavigationDefinition(selected, {
      origin: { surfaceId: "code", range },
      location: RepositoryLanguageLocationLink.make({
        originSelectionRange: Option.none(),
        target: RepositoryLanguageLocation.make({ path: sourcePath, range }),
        targetSelectionRange: range,
      }),
    })
    const decoded = decodeCodeNavigationState(definition)
    const refreshed = encodeCodeNavigationState({
      target: decoded.target,
      path: decoded.path,
      revealRange: decoded.revealRange,
      fileStatuses: HashMap.make([targetPath, "added" as const]),
      lineChanges: HashMap.empty(),
    })

    expect(decoded.path).toEqual(Option.some(sourcePath))
    expect(decoded.revealRange).toEqual(Option.some(range))
    expect(codeNavigationContribution.sameState(definition, refreshed)).toBe(true)
    expect(codeNavigationContribution.isValidState({ invalid: true })).toBe(false)
  })
})
