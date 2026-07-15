import { isExternalUrlAllowed } from "./electron-policy"

type OpenExternal = (url: string) => Promise<void>
type OpenPath = (path: string) => Promise<string>

/** Opens a local path and converts Electron's non-empty error string into a rejected request. */
export const openLocalPath = async (openPath: OpenPath, targetPath: string) => {
  const errorMessage = await openPath(targetPath)
  if (errorMessage.length > 0) throw new Error(errorMessage)
}

/** Delegates an allowed external URL and reports whether a side effect was attempted. */
export const openAllowedExternalUrl = async (openExternal: OpenExternal, url: string) => {
  if (!isExternalUrlAllowed(url)) return false
  await openExternal(url)
  return true
}

/** Opens a provider file URL at the immutable head SHA when available. */
export const openProviderFile = async (
  gitProvider: {
    readonly fileUrl: (owner: string, name: string, filePath: string, ref: string) => string
  },
  openExternal: OpenExternal,
  owner: string,
  name: string,
  filePath: string,
  headRefName: string,
  headRefOid: string | null,
) => {
  const ref = headRefOid ?? headRefName
  await openExternal(gitProvider.fileUrl(owner, name, filePath, ref))
}
