import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const homebrewExpatLibraryPath = "/opt/homebrew/opt/expat/lib"

/** Returns a required non-blank environment value without exposing it in an error. */
export const requiredEnvironment = (name, environment = process.env) => {
  const value = environment[name]
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

/** Returns the public PostHog configuration required in every packaged release. */
export const requiredAnalyticsEnvironment = (environment = process.env) => ({
  host: requiredEnvironment("VITE_POSTHOG_HOST", environment),
  key: requiredEnvironment("VITE_POSTHOG_KEY", environment),
})

/** Builds the shared R2 endpoint and credential environment used by the AWS CLI. */
export const createR2ClientConfiguration = (
  environment = process.env,
  { platform = process.platform, pathExists = existsSync } = {},
) => {
  const awsEnvironment = {
    ...environment,
    AWS_ACCESS_KEY_ID: requiredEnvironment("R2_ACCESS_KEY_ID", environment),
    AWS_SECRET_ACCESS_KEY: requiredEnvironment("R2_SECRET_ACCESS_KEY", environment),
    AWS_DEFAULT_REGION: "auto",
    AWS_EC2_METADATA_DISABLED: "true",
  }

  if (
    platform === "darwin" &&
    awsEnvironment.DYLD_LIBRARY_PATH === undefined &&
    pathExists(homebrewExpatLibraryPath)
  ) {
    awsEnvironment.DYLD_LIBRARY_PATH = homebrewExpatLibraryPath
  }

  return {
    bucket: requiredEnvironment("R2_BUCKET", environment),
    endpoint: `https://${requiredEnvironment("CLOUDFLARE_ACCOUNT_ID", environment)}.r2.cloudflarestorage.com`,
    awsEnvironment,
  }
}

// Keep this parser until process.loadEnvFile parity is proven. Release files rely on the current
// environment-first precedence and exact quote, escape, and inline-comment behavior below.
/** Parses one line using the release scripts' intentionally narrow dotenv grammar. */
export const parseLocalEnvLine = (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null

  const withoutExport = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length).trim()
    : trimmed
  const equalsIndex = withoutExport.indexOf("=")
  if (equalsIndex <= 0) return null

  const name = withoutExport.slice(0, equalsIndex).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return null

  const rawValue = withoutExport.slice(equalsIndex + 1).trim()
  return [name, parseLocalEnvValue(rawValue)]
}

/** Loads a local release environment file without overriding the existing environment. */
export const loadLocalEnvironment = (
  environment = process.env,
  {
    cwd = process.cwd(),
    envFile = environment.DIFFDASH_ENV_FILE ?? ".env",
    pathExists = existsSync,
    readFile = readFileSync,
  } = {},
) => {
  const envPath = path.resolve(cwd, envFile)
  if (!pathExists(envPath)) return

  const content = readFile(envPath, "utf8")
  for (const line of content.split(/\r?\n/u)) {
    const parsed = parseLocalEnvLine(line)
    if (parsed === null) continue

    const [name, value] = parsed
    environment[name] ??= value
  }
}

const parseLocalEnvValue = (value) => {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/gu, "\n").replace(/\\r/gu, "\r").replace(/\\t/gu, "\t")
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1)
  }

  const commentIndex = value.search(/\s+#/u)
  return (commentIndex === -1 ? value : value.slice(0, commentIndex)).trim()
}
