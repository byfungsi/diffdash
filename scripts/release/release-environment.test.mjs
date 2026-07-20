import assert from "node:assert/strict"
import test from "node:test"

import {
  createR2ClientConfiguration,
  loadLocalEnvironment,
  parseLocalEnvLine,
  requiredEnvironment,
} from "./release-environment.mjs"

const r2Environment = () => ({
  CLOUDFLARE_ACCOUNT_ID: "account-id",
  R2_ACCESS_KEY_ID: "access-key",
  R2_SECRET_ACCESS_KEY: "secret-key",
  R2_BUCKET: "release-bucket",
})

test("required environment access rejects missing and blank values without exposing credentials", () => {
  assert.equal(requiredEnvironment("TOKEN", { TOKEN: " secret " }), " secret ")
  assert.throws(() => requiredEnvironment("TOKEN", {}), /TOKEN/u)
  assert.throws(() => requiredEnvironment("TOKEN", { TOKEN: "   " }), /TOKEN/u)
})

test("builds the R2 endpoint and AWS environment without mutating the source", () => {
  const environment = r2Environment()
  const configuration = createR2ClientConfiguration(environment, {
    platform: "linux",
    pathExists: () => true,
  })

  assert.equal(configuration.bucket, "release-bucket")
  assert.equal(configuration.endpoint, "https://account-id.r2.cloudflarestorage.com")
  assert.equal(configuration.awsEnvironment.AWS_ACCESS_KEY_ID, "access-key")
  assert.equal(configuration.awsEnvironment.AWS_SECRET_ACCESS_KEY, "secret-key")
  assert.equal(configuration.awsEnvironment.AWS_DEFAULT_REGION, "auto")
  assert.equal(configuration.awsEnvironment.AWS_EC2_METADATA_DISABLED, "true")
  assert.equal(configuration.awsEnvironment.DYLD_LIBRARY_PATH, undefined)
  assert.equal(environment.AWS_ACCESS_KEY_ID, undefined)
})

test("adds the Homebrew expat library only when the macOS AWS environment needs it", () => {
  const configured = createR2ClientConfiguration(r2Environment(), {
    platform: "darwin",
    pathExists: (candidate) => candidate === "/opt/homebrew/opt/expat/lib",
  })
  assert.equal(configured.awsEnvironment.DYLD_LIBRARY_PATH, "/opt/homebrew/opt/expat/lib")

  const existing = createR2ClientConfiguration(
    { ...r2Environment(), DYLD_LIBRARY_PATH: "/custom/lib" },
    { platform: "darwin", pathExists: () => true },
  )
  assert.equal(existing.awsEnvironment.DYLD_LIBRARY_PATH, "/custom/lib")

  const unavailable = createR2ClientConfiguration(r2Environment(), {
    platform: "darwin",
    pathExists: () => false,
  })
  assert.equal(unavailable.awsEnvironment.DYLD_LIBRARY_PATH, undefined)
})

test("preserves the existing local env precedence and quoting grammar", () => {
  assert.deepEqual(parseLocalEnvLine('export QUOTED="line\\nnext"'), ["QUOTED", "line\nnext"])
  assert.deepEqual(parseLocalEnvLine("SINGLE='literal\\nvalue'"), ["SINGLE", "literal\\nvalue"])
  assert.deepEqual(parseLocalEnvLine("PLAIN=value # comment"), ["PLAIN", "value"])
  assert.equal(parseLocalEnvLine("1INVALID=value"), null)

  const environment = { EXISTING: "shell-value" }
  loadLocalEnvironment(environment, {
    cwd: "/workspace",
    envFile: ".release.env",
    pathExists: (candidate) => candidate === "/workspace/.release.env",
    readFile: () =>
      [
        "EXISTING=file-value",
        'DOUBLE="tab\\tvalue"',
        "SINGLE='hash # retained'",
        "PLAIN=value # removed",
      ].join("\n"),
  })

  assert.deepEqual(environment, {
    EXISTING: "shell-value",
    DOUBLE: "tab\tvalue",
    SINGLE: "hash # retained",
    PLAIN: "value",
  })
})

test("reports each missing R2 setting by name without including other values", () => {
  const environment = r2Environment()
  delete environment.R2_SECRET_ACCESS_KEY

  assert.throws(
    () => createR2ClientConfiguration(environment),
    (error) => {
      assert.match(error.message, /R2_SECRET_ACCESS_KEY/u)
      assert.doesNotMatch(error.message, /access-key|account-id/u)
      return true
    },
  )
})
