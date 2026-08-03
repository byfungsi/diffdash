/** Repository operations with distinct cache dependencies. */
export type RepositoryMutationKind =
  | "favorite"
  | "rememberRemote"
  | "setFavorite"
  | "install"
  | "link"
  | "forget"

/** Query invalidations owned by repository mutation coordination. */
export type RepositoryQueryInvalidations = {
  readonly repositories: () => void
  readonly localSearch: () => void
  readonly remoteSearch: () => void
  readonly selectedReviews: () => void
}

const INVALIDATION_TARGETS = {
  favorite: ["repositories", "localSearch", "remoteSearch"],
  rememberRemote: ["repositories", "localSearch", "remoteSearch"],
  setFavorite: ["repositories", "localSearch", "remoteSearch"],
  install: ["repositories", "localSearch"],
  link: ["repositories", "localSearch"],
  forget: ["repositories", "localSearch", "remoteSearch", "selectedReviews"],
} as const satisfies Record<RepositoryMutationKind, readonly (keyof RepositoryQueryInvalidations)[]>

/** Invalidates every intended repository dependency exactly once after a successful mutation. */
const invalidateRepositoryQueries = (
  kind: RepositoryMutationKind,
  invalidations: RepositoryQueryInvalidations,
): void => {
  INVALIDATION_TARGETS[kind].forEach((target) => invalidations[target]())
}

/** Runs a repository mutation and applies its domain-owned query invalidations on success. */
export const runRepositoryMutation = async <Value>(
  kind: RepositoryMutationKind,
  mutation: () => Promise<Value>,
  invalidations: RepositoryQueryInvalidations,
): Promise<Value> => {
  const value = await mutation()
  invalidateRepositoryQueries(kind, invalidations)
  return value
}
