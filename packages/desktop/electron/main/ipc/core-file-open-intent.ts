import { CoreAbsolutePath, type CoreFileOpenIntent, type CoreWebUrl } from "@diffdash/core"
import { Match } from "effect"

import { resolveContainedRepositoryPath } from "../electron-policy"

/** Exhaustively executes one Core file-open intent through native host capabilities. */
export const openCoreFileIntent = (
  intent: CoreFileOpenIntent,
  capabilities: {
    readonly openExternal: (url: CoreWebUrl) => Promise<boolean>
    readonly openLocal: (path: CoreAbsolutePath) => Promise<void>
  },
): Promise<void> =>
  Match.valueTags(intent, {
    external: async ({ url }) => {
      await capabilities.openExternal(url)
    },
    local: ({ rootPath, filePath }) =>
      capabilities.openLocal(
        CoreAbsolutePath.make(resolveContainedRepositoryPath(rootPath, filePath)),
      ),
  })
