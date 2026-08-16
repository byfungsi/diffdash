import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const desktopDirectory = fileURLToPath(new URL("../../desktop", import.meta.url))
const leaseDirectory = resolve(
  process.env.DIFFDASH_E2E_BUILD_LEASE_PATH ??
    resolve(desktopDirectory, ".generated/e2e-build.lease"),
)
const ownerPath = resolve(leaseDirectory, "owner.json")
const retryMilliseconds = 100
const timeoutMilliseconds = 120_000

/** Prevents complete Desktop E2E build-and-run workflows from interleaving shared artifacts. */
export const withDesktopBuildLease = async (operation) => {
  const token = randomUUID()
  const deadline = Date.now() + timeoutMilliseconds
  while (!(await tryAcquire(token))) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the Desktop E2E build lease.")
    await new Promise((resolvePromise) => setTimeout(resolvePromise, retryMilliseconds))
  }

  const release = () => rm(leaseDirectory, { force: true, recursive: true }).catch(() => undefined)
  const terminate = (signal) => {
    void release().finally(() => process.kill(process.pid, signal))
  }
  process.once("SIGINT", terminate)
  process.once("SIGTERM", terminate)
  try {
    return await operation()
  } finally {
    process.removeListener("SIGINT", terminate)
    process.removeListener("SIGTERM", terminate)
    await release()
  }
}

const tryAcquire = async (token) => {
  const candidateDirectory = `${leaseDirectory}.candidate-${token}`
  try {
    await mkdir(candidateDirectory, { recursive: true })
    await writeFile(
      resolve(candidateDirectory, "owner.json"),
      `${JSON.stringify({ pid: process.pid, token })}\n`,
      "utf8",
    )
    await rename(candidateDirectory, leaseDirectory)
    return true
  } catch (error) {
    await rm(candidateDirectory, { force: true, recursive: true })
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        (error.code === "EEXIST" || error.code === "ENOTEMPTY")
      )
    )
      throw error
  }

  if (await ownerIsAlive()) return false
  await rm(leaseDirectory, { force: true, recursive: true })
  return false
}

const ownerIsAlive = async () => {
  try {
    const owner = JSON.parse(await readFile(ownerPath, "utf8"))
    if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}
