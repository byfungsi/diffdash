import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { basename, resolve } from "node:path"

const MANIFEST_VERSION = 1

const runGit = (args, options = {}) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout = []
    const stderr = []
    child.stdout.on("data", (chunk) => stdout.push(chunk))
    child.stderr.on("data", (chunk) => stderr.push(chunk))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout).toString("utf8").trim())
        return
      }
      reject(
        new Error(
          Buffer.concat(stderr).toString("utf8").trim() || `git exited with status ${code}`,
        ),
      )
    })
  })

const resolveRevision = (repository, revision) =>
  runGit(["rev-parse", "--verify", `${revision}^{commit}`], { cwd: repository })

const readDiffScale = (repository, baseSha, headSha) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(
      "git",
      ["diff", "--numstat", "--no-renames", "-z", baseSha, headSha, "--"],
      {
        cwd: repository,
        env: { ...process.env, LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    let pending = Buffer.alloc(0)
    let changedFiles = 0
    let addedRows = 0
    let deletedRows = 0
    let binaryFiles = 0
    const stderr = []

    const consume = (record) => {
      if (record.length === 0) return
      const firstTab = record.indexOf(0x09)
      const secondTab = firstTab < 0 ? -1 : record.indexOf(0x09, firstTab + 1)
      if (firstTab < 0 || secondTab < 0) {
        throw new Error("git produced an invalid numstat record")
      }
      const added = record.subarray(0, firstTab).toString("utf8")
      const deleted = record.subarray(firstTab + 1, secondTab).toString("utf8")
      changedFiles += 1
      if (added === "-" || deleted === "-") {
        binaryFiles += 1
        return
      }
      addedRows += Number.parseInt(added, 10)
      deletedRows += Number.parseInt(deleted, 10)
    }

    child.stdout.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk])
      let separator = pending.indexOf(0)
      while (separator >= 0) {
        consume(pending.subarray(0, separator))
        pending = pending.subarray(separator + 1)
        separator = pending.indexOf(0)
      }
    })
    child.stderr.on("data", (chunk) => stderr.push(chunk))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            Buffer.concat(stderr).toString("utf8").trim() || `git diff exited with status ${code}`,
          ),
        )
        return
      }
      if (pending.length > 0) {
        reject(new Error("git produced an incomplete numstat record"))
        return
      }
      resolvePromise({ addedRows, binaryFiles, changedFiles, deletedRows })
    })
  })

const fixtureId = (name, baseSha, headSha) => {
  const digest = createHash("sha256").update(`${baseSha}\0${headSha}`).digest("hex").slice(0, 12)
  return `${name}-${digest}`
}

const pathExists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Creates an ignored, network-independent comparison fixture from an existing local Git checkout.
 */
export const prepareGitFixture = async ({ source, base, head, name, cacheDirectory }) => {
  const sourcePath = await realpath(resolve(source))
  const sourceIsRepository = await runGit(["rev-parse", "--is-inside-work-tree"], {
    cwd: sourcePath,
  })
  if (sourceIsRepository !== "true") throw new Error(`${sourcePath} is not a Git work tree`)

  const [baseSha, headSha] = await Promise.all([
    resolveRevision(sourcePath, base),
    resolveRevision(sourcePath, head),
  ])
  const normalizedName = name ?? basename(sourcePath)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalizedName)) {
    throw new Error(
      "Fixture name must contain only letters, numbers, dots, underscores, and dashes",
    )
  }
  const id = fixtureId(normalizedName, baseSha, headSha)
  const fixtureDirectory = resolve(cacheDirectory, "fixtures", id)
  const repository = resolve(fixtureDirectory, "repository")
  const manifestPath = resolve(fixtureDirectory, "manifest.json")

  if ((await pathExists(manifestPath)) && (await pathExists(repository))) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    return { fixtureDirectory, manifest, manifestPath, repository }
  }

  await rm(fixtureDirectory, { recursive: true, force: true })
  await mkdir(fixtureDirectory, { recursive: true })
  try {
    await runGit(["clone", "--shared", "--no-checkout", "--quiet", sourcePath, repository])
    const scale = await readDiffScale(repository, baseSha, headSha)
    const manifest = {
      version: MANIFEST_VERSION,
      id,
      name: normalizedName,
      baseSha,
      headSha,
      scale,
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    return { fixtureDirectory, manifest, manifestPath, repository }
  } catch (error) {
    await rm(fixtureDirectory, { recursive: true, force: true })
    throw error
  }
}
