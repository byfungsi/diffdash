import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

const FIXTURE_DATE = "2026-01-01T00:00:00Z"
const SCENARIO_INDICES = {
  enormousFile: 0,
  wrappedLine: 1,
  annotation: 2,
  broadSearch: 3,
  binary: 4,
  rename: 5,
  delete: 6,
  executableModeChange: 7,
  noNewline: 8,
  denseThread: 9,
}
const ZERO_ADDITION_INDICES = [
  SCENARIO_INDICES.binary,
  SCENARIO_INDICES.rename,
  SCENARIO_INDICES.delete,
  SCENARIO_INDICES.executableModeChange,
]
const BINARY_BASE_CONTENT = Buffer.from([0x00, 0x44, 0x49, 0x46, 0x46, 0x42, 0x41, 0x53, 0x45])
const BINARY_HEAD_CONTENT = Buffer.from([0x00, 0x44, 0x49, 0x46, 0x46, 0x48, 0x45, 0x41, 0x44])

const scenarioPaths = {
  binary: "fixture/scenarios/binary.bin",
  deleted: "fixture/scenarios/deleted.txt",
  executableModeChange: "fixture/scenarios/executable.sh",
  noNewline: "fixture/scenarios/no-newline.txt",
  renameFrom: "fixture/scenarios/rename-source.txt",
  renameTo: "fixture/scenarios/renamed-target.txt",
}

const fixtureId = (profile, baseSha, headSha, revisionSha) => {
  const digest = createHash("sha256")
    .update(JSON.stringify({ profile, baseSha, headSha, revisionSha }))
    .digest("hex")
    .slice(0, 16)
  return `pathological-${digest}`
}

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
  if (profile.fileCount < Object.keys(SCENARIO_INDICES).length) {
    throw new Error("fileCount must leave room for all fixture scenarios")
  }
  const rowContributingFiles = profile.fileCount - ZERO_ADDITION_INDICES.length
  if (profile.rowCount < profile.enormousFileRows + rowContributingFiles - 1) {
    throw new Error("rowCount cannot be distributed across the requested files")
  }
}

const rowAllocation = (profile, index) => {
  if (ZERO_ADDITION_INDICES.includes(index)) return 0
  if (index === SCENARIO_INDICES.enormousFile) return profile.enormousFileRows
  const remainingRows = profile.rowCount - profile.enormousFileRows
  const remainingFiles = profile.fileCount - ZERO_ADDITION_INDICES.length - 1
  const quotient = Math.floor(remainingRows / remainingFiles)
  const allocationRank = index - ZERO_ADDITION_INDICES.filter((value) => value <= index).length
  return quotient + (allocationRank <= remainingRows % remainingFiles ? 1 : 0)
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
    index === SCENARIO_INDICES.annotation
      ? "annotation-anchor"
      : index === SCENARIO_INDICES.broadSearch
        ? "broad-search-match"
        : index === SCENARIO_INDICES.denseThread
          ? "dense-thread-anchor"
          : "scale-row"
  const lines = Array.from({ length: rows })
  for (let row = 0; row < rows; row += 1) {
    lines[row] =
      `${marker} file=${String(index).padStart(5, "0")} row=${String(row).padStart(7, "0")} value=head\n`
  }
  if (index === SCENARIO_INDICES.wrappedLine) lines[0] = `${"w".repeat(wrappedLineBytes)}\n`
  return lines.join("")
}

const noNewlineContent = (rows) =>
  Array.from(
    { length: rows },
    (_, row) => `no-newline row=${String(row).padStart(7, "0")} value=head`,
  ).join("\n")

const writeScenarioBase = async (repository) => {
  const path = (name) => join(repository, scenarioPaths[name])
  await mkdir(dirname(path("binary")), { recursive: true })
  await Promise.all([
    writeFile(path("binary"), BINARY_BASE_CONTENT),
    writeFile(path("deleted"), "deleted in head\n"),
    writeFile(path("executableModeChange"), "#!/bin/sh\nprintf 'mode-only fixture\\n'\n"),
    writeFile(path("noNewline"), "no-newline value=base"),
    writeFile(path("renameFrom"), "pure rename fixture\n"),
  ])
}

const writeScenarioHead = async (repository, profile) => {
  await writeFile(join(repository, scenarioPaths.binary), BINARY_HEAD_CONTENT)
  await writeFile(
    join(repository, scenarioPaths.noNewline),
    noNewlineContent(rowAllocation(profile, SCENARIO_INDICES.noNewline)),
  )
  await rm(join(repository, scenarioPaths.deleted))
  await runGit(repository, ["mv", scenarioPaths.renameFrom, scenarioPaths.renameTo])
}

const writeFiles = async (repository, profile, start = 0) => {
  if (start >= profile.fileCount) return
  const end = Math.min(start + 128, profile.fileCount)
  await Promise.all(
    Array.from({ length: end - start }, async (_, offset) => {
      const index = start + offset
      if (ZERO_ADDITION_INDICES.includes(index) || index === SCENARIO_INDICES.noNewline) return
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
  await writeScenarioBase(repository)
  await runGit(repository, ["add", "--all"])
  await runGit(repository, ["commit", "--quiet", "-m", "fixture base"])
  const baseSha = await runGit(repository, ["rev-parse", "HEAD"])

  await writeFiles(repository, profile)
  await writeScenarioHead(repository, profile)
  await runGit(repository, ["add", "--all"])
  await runGit(repository, ["update-index", "--chmod=+x", scenarioPaths.executableModeChange])
  await runGit(repository, ["commit", "--quiet", "-m", "fixture pathological comparison"])
  const headSha = await runGit(repository, ["rev-parse", "HEAD"])

  await writeFile(
    filePath(repository, SCENARIO_INDICES.annotation),
    "annotation-anchor moved by revision change\n",
  )
  await runGit(repository, ["add", "--all"])
  await runGit(repository, ["commit", "--quiet", "-m", "fixture revision change"])
  const revisionSha = await runGit(repository, ["rev-parse", "HEAD"])
  await runGit(repository, ["checkout", "--quiet", headSha])

  const manifest = {
    version: 2,
    id: fixtureId(profile, baseSha, headSha, revisionSha),
    kind: "synthetic-repository-scale",
    baseSha,
    headSha,
    revisionSha,
    profile,
    scale: {
      addedRows: profile.rowCount,
      binaryFiles: 1,
      changedFiles: profile.fileCount,
      deletedRows: 2,
    },
    scenarios: {
      annotation: "fixture/000/00002.txt",
      binary: scenarioPaths.binary,
      broadSearch: "fixture/000/00003.txt",
      delete: scenarioPaths.deleted,
      denseThread: "fixture/000/00009.txt",
      enormousFile: "fixture/000/00000.txt",
      executableModeChange: scenarioPaths.executableModeChange,
      noNewline: scenarioPaths.noNewline,
      rename: { from: scenarioPaths.renameFrom, to: scenarioPaths.renameTo },
      revisionChange: { from: headSha, to: revisionSha },
      wrappedLine: "fixture/000/00001.txt",
    },
  }
  const manifestPath = join(repository, "..", "manifest.json")
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { manifest, manifestPath, repository }
}
