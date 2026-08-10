import { Schema } from "effect"

const forbiddenGitRevisionCharacters = new Set(["~", "^", ":", "?", "*", "[", "\\"])

const isSafeGitRevisionInput = (input: string): boolean => {
  if (
    input.length === 0 ||
    input.length > 255 ||
    input === "@" ||
    input.startsWith("-") ||
    input.startsWith(".") ||
    input.endsWith(".") ||
    input.endsWith("/") ||
    input.includes("..") ||
    input.includes("//") ||
    input.includes("@{") ||
    input.split("/").some((component) => component.startsWith(".") || component.endsWith(".lock"))
  ) {
    return false
  }

  return [...input].every((character) => {
    const codePoint = character.codePointAt(0)
    return (
      codePoint !== undefined &&
      codePoint > 0x20 &&
      codePoint !== 0x7f &&
      !forbiddenGitRevisionCharacters.has(character)
    )
  })
}

/** Safe branch, tag, or full commit input for one repository comparison. */
export const RepositoryComparisonRef = Schema.String.pipe(
  Schema.check(Schema.makeFilter(isSafeGitRevisionInput, { message: "Invalid Git revision" })),
  Schema.brand("RepositoryComparisonRef"),
)

/** Safe branch, tag, or full commit input for one repository comparison. */
export type RepositoryComparisonRef = typeof RepositoryComparisonRef.Type
