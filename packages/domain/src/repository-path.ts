import { Schema } from "effect"

const isRepositoryRelativePath = (path: string): boolean => {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:/u.test(path)
  ) {
    return false
  }

  return !path.replaceAll("\\", "/").split("/").includes("..")
}

/** Repository-relative file path that cannot escape its checkout root. */
export const RepositoryRelativePath = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(isRepositoryRelativePath, {
      message: "Expected a repository-relative path without parent traversal",
    }),
  ),
  Schema.brand("RepositoryRelativePath"),
)

/** Repository-relative file path that cannot escape its checkout root. */
export type RepositoryRelativePath = typeof RepositoryRelativePath.Type
