import { spawn } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

const FIXTURE_DATE = "2026-01-01T00:00:00Z"

/** Default deterministic pathological comparison required by the M21 scale benchmark. */
export const repositoryScaleProfile = {
  fileCount: 61_000,
  rowCount: 30_000_000,
  enormousFileRows: 1_000_000,
  wrappedLineBytes: 256 * 1024,
}

const runGit = (repository, args) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: repository,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: FIXTURE_DATE,
        GIT_AUTHOR_EMAIL: "fixture@diffdash.invalid",
        GIT_AUTHOR_NAME: "DiffDash Fixture",
        GIT_COMMITTER_DATE: FIXTURE_DATE,
        GIT_COMMITTER_EMAIL: "fixture@diffdash.invalid",
        GIT_COMMITTER_NAME: "DiffDash Fixture",
        LC_ALL: "C",
      },
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
      reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `git exited with ${code}`))
    })
  })

const validateProfile = (profile) => {
  for (const field of ["fileCount", "rowCount", "enormousFileRows", "wrappedLineBytes"]) {
    if (!Number.isSafeInteger(profile[field]) || profile[field] <= 0) {
      throw new Error(`${field} must be a positive safe integer`)
    }
  }
  if (profile.fileCount < 5) throw new Error("fileCount must leave room for all fixture scenarios")
  if (profile.rowCount < profile.enormousFileRows + profile.fileCount - 1) {
    throw new Error("rowCount cannot be distributed across the requested files")
  }
}

const rowAllocation = (profile, index) => {
  if (index === 0) return profile.enormousFileRows
  const remainingRows = profile.rowCount - profile.enormousFileRows
  const remainingFiles = profile.fileCount - 1
  const quotient = Math.floor(remainingRows / remainingFiles)
  return quotient + (index <= remainingRows % remainingFiles ? 1 : 0)
}

const filePath = (repository, index) =>
  join(
    repository,
    "fixture",
    String(Math.floor(index / 1_000)).padStart(3, "0"),
    `${String(index).padStart(5, "0")}.txt`,
  )

const contentFor = (index, rows, wrappedLineBytes) => {
  const marker =
    index === 2 ? "annotation-anchor" : index === 3 ? "broad-search-match" : "scale-row"
  const lines = Array.from({ length: rows })
  for (let row = 0; row < rows; row += 1) {
    lines[row] =
      `${marker} file=${String(index).padStart(5, "0")} row=${String(row).padStart(7, "0")} value=head\n`
  }
  if (index === 1) lines[0] = `${"w".repeat(wrappedLineBytes)}\n`
  return lines.join("")
}

const writeFiles = async (repository, profile, start = 0) => {
  if (start >= profile.fileCount) return
  const end = Math.min(start + 128, profile.fileCount)
  await Promise.all(
    Array.from({ length: end - start }, async (_, offset) => {
      const index = start + offset
      const path = filePath(repository, index)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(
        path,
        contentFor(index, rowAllocation(profile, index), profile.wrappedLineBytes),
      )
    }),
  )
  await writeFiles(repository, profile, end)
}

/** Generates an ignored Git fixture without network access or checked-in patch data. */
export const generateSyntheticFixture = async ({ directory, profile = repositoryScaleProfile }) => {
  validateProfile(profile)
  const repository = resolve(directory)
  await rm(repository, { recursive: true, force: true })
  await mkdir(repository, { recursive: true })
  await runGit(repository, ["init", "--quiet", "--initial-branch=main"])
  await runGit(repository, ["commit", "--quiet", "--allow-empty", "-m", "fixture base"])
  const baseSha = await runGit(repository, ["rev-parse", "HEAD"])

  await writeFiles(repository, profile)
  await runGit(repository, ["add", "--all"])
  await runGit(repository, ["commit", "--quiet", "-m", "fixture pathological comparison"])
  const headSha = await runGit(repository, ["rev-parse", "HEAD"])

  await writeFile(filePath(repository, 2), "annotation-anchor moved by revision change\n")
  await runGit(repository, ["add", "--all"])
  await runGit(repository, ["commit", "--quiet", "-m", "fixture revision change"])
  const revisionSha = await runGit(repository, ["rev-parse", "HEAD"])
  await runGit(repository, ["checkout", "--quiet", headSha])

  const manifest = {
    version: 1,
    kind: "synthetic-repository-scale",
    baseSha,
    headSha,
    revisionSha,
    profile,
    scenarios: {
      annotation: "fixture/000/00002.txt",
      broadSearch: "fixture/000/00003.txt",
      enormousFile: "fixture/000/00000.txt",
      revisionChange: { from: headSha, to: revisionSha },
      wrappedLine: "fixture/000/00001.txt",
    },
  }
  const manifestPath = join(repository, "..", "manifest.json")
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { manifest, manifestPath, repository }
}
