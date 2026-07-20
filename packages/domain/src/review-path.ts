/** Returns the final segment of a POSIX/Git review path. */
export const reviewPathBasename = (path: string) => {
  const trimmedPath = path.endsWith("/") ? path.slice(0, -1) : path
  const separatorIndex = trimmedPath.lastIndexOf("/")
  return separatorIndex < 0 ? trimmedPath : trimmedPath.slice(separatorIndex + 1)
}

/** Returns the directory of a POSIX/Git review path, or null for a root-level path. */
export const reviewPathDirectory = (path: string): string | null => {
  const separatorIndex = path.lastIndexOf("/")
  return separatorIndex < 0 ? null : path.slice(0, separatorIndex)
}
