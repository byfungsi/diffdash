import { Redacted, Schema } from "effect"

const GITHUB_PAT_STORAGE_KEY = "diffdash.cloud.github-pat.v1"

const GithubPersonalAccessTokenValue = Schema.String.pipe(
  Schema.check(Schema.isMinLength(20)),
  Schema.check(Schema.isMaxLength(512)),
  Schema.check(Schema.isPattern(/^\S+$/u)),
)

/** Browser-owned GitHub credential kept redacted outside the final HTTP and storage boundaries. */
export type GithubPersonalAccessToken = Redacted.Redacted<string>

/** Parses a user-supplied GitHub personal access token without retaining the raw input. */
export const parseGithubPersonalAccessToken = (input: string): GithubPersonalAccessToken =>
  Redacted.make(Schema.decodeUnknownSync(GithubPersonalAccessTokenValue)(input.trim()))

/** Loads and parses the locally persisted GitHub credential, removing malformed storage values. */
export const loadGithubPersonalAccessToken = (): GithubPersonalAccessToken | null => {
  const stored = window.localStorage.getItem(GITHUB_PAT_STORAGE_KEY)
  if (stored === null) return null
  try {
    return parseGithubPersonalAccessToken(stored)
  } catch {
    window.localStorage.removeItem(GITHUB_PAT_STORAGE_KEY)
    return null
  }
}

/** Persists the GitHub credential in the explicit personal-v0 browser boundary. */
export const saveGithubPersonalAccessToken = (token: GithubPersonalAccessToken): void => {
  window.localStorage.setItem(GITHUB_PAT_STORAGE_KEY, Redacted.value(token))
}

/** Removes the locally persisted GitHub credential. */
export const clearGithubPersonalAccessToken = (): void => {
  window.localStorage.removeItem(GITHUB_PAT_STORAGE_KEY)
}
