import { REPOSITORY_SCOPED_GIT_ENV } from "../git-environment"

/** Copies a test process environment without repository-scoped Git variables. */
export const sanitizedGitTestEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const sanitized = { ...environment }
  for (const key of REPOSITORY_SCOPED_GIT_ENV) delete sanitized[key]
  return sanitized
}
