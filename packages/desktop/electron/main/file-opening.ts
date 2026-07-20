type OpenExternalUrl = (url: string) => Promise<boolean>
type OpenPath = (path: string) => Promise<string>

/** Opens a local path and converts Electron's non-empty error string into a rejected request. */
export const openLocalPath = async (openPath: OpenPath, targetPath: string) => {
  const errorMessage = await openPath(targetPath)
  if (errorMessage.length > 0) throw new Error(errorMessage)
}

/** Opens a provider file URL at the immutable head SHA when available. */
export const openProviderFile = async (
  fileUrl: (
    repository: import("@diffdash/domain/git-provider").HostedRepositoryLocator,
    filePath: string,
    ref: string,
  ) => Promise<string>,
  openExternalUrl: OpenExternalUrl,
  repository: import("@diffdash/domain/git-provider").HostedRepositoryLocator,
  filePath: string,
  headRefName: string,
  headRefOid: string | null,
) => {
  const ref = headRefOid ?? headRefName
  const url = await fileUrl(repository, filePath, ref)
  await openExternalUrl(url)
}
