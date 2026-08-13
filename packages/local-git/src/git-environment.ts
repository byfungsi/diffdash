import { processRequest, type ProcessRequest, type ProcessRequestOptions } from "@diffdash/process"

/** Git variables that bind a subprocess to the repository selected by its parent process. */
export const REPOSITORY_SCOPED_GIT_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
] as const

/** Creates an isolated Git process request for a repository selected by its command arguments. */
export const gitProcessRequest = (
  args: readonly string[],
  options: ProcessRequestOptions = {},
): ProcessRequest =>
  processRequest("git", args, {
    ...options,
    unsetEnv: [...REPOSITORY_SCOPED_GIT_ENV, ...(options.unsetEnv ?? [])],
  })
