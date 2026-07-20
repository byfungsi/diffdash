/** Checks whether an unknown failure exposes a Node filesystem error code. */
export const isNodeError = (cause: unknown): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause
