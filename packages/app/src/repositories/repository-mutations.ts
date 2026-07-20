/** Repository operations with distinct cache dependencies. */
export type RepositoryMutationKind = "favorite" | "install" | "link" | "remove"

/** Query invalidations owned by repository mutation coordination. */
export type RepositoryQueryInvalidations = {
  readonly repositories: () => void
  readonly localSearch: () => void
  readonly remoteSearch: () => void
  readonly counts: () => void
  readonly selectedReviews: () => void
}

const INVALIDATION_TARGETS = {
  favorite: ["repositories", "localSearch", "remoteSearch", "counts"],
  install: ["repositories", "localSearch", "counts"],
  link: ["repositories", "localSearch", "counts"],
  remove: ["repositories", "localSearch", "remoteSearch", "counts", "selectedReviews"],
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
