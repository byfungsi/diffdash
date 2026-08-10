import type { CoreAbsolutePath } from "@diffdash/core"

type OpenPath = (path: CoreAbsolutePath) => Promise<string>

/** Opens a local path and converts Electron's non-empty error string into a rejected request. */
export const openLocalPath = async (openPath: OpenPath, targetPath: CoreAbsolutePath) => {
  const errorMessage = await openPath(targetPath)
  if (errorMessage.length > 0) throw new Error(errorMessage)
}
