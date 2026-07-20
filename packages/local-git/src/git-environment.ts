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

/** Copies an environment without variables that redirect Git to the parent's repository. */
export const sanitizedGitEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const sanitized = { ...environment }
  for (const key of REPOSITORY_SCOPED_GIT_ENV) delete sanitized[key]
  return sanitized
}
