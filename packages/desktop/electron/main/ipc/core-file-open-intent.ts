import type { CoreFileOpenIntent } from "@diffdash/core"
import { Match } from "effect"

import { resolveContainedRepositoryPath } from "../electron-policy"

/** Exhaustively executes one Core file-open intent through native host capabilities. */
export const openCoreFileIntent = (
  intent: CoreFileOpenIntent,
  capabilities: {
    readonly openExternal: (url: string) => Promise<unknown>
    readonly openLocal: (path: string) => Promise<void>
  },
): Promise<void> =>
  Match.valueTags(intent, {
    external: async ({ url }) => {
      await capabilities.openExternal(url)
    },
    local: ({ rootPath, filePath }) =>
      capabilities.openLocal(resolveContainedRepositoryPath(rootPath, filePath)),
  })
