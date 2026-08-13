import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import assert from "node:assert/strict"

import { prepareGitFixture } from "../src/git-fixture.mjs"

const execFilePromise = promisify(execFile)

const git = (cwd, ...args) =>
  execFilePromise("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "DiffDash Fixture",
      GIT_AUTHOR_EMAIL: "fixture@diffdash.invalid",
      GIT_COMMITTER_NAME: "DiffDash Fixture",
      GIT_COMMITTER_EMAIL: "fixture@diffdash.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  })

test("prepares a pinned local comparison without materializing a patch", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "diffdash-repository-scale-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, "source")
  const cacheDirectory = join(root, "cache")
  await execFilePromise("git", ["init", "--quiet", source])
  await writeFile(join(source, "example.txt"), "first\n")
  await git(source, "add", "example.txt")
  await git(source, "commit", "--quiet", "-m", "base")
  const { stdout: baseOutput } = await git(source, "rev-parse", "HEAD")
  const baseSha = baseOutput.trim()
  await writeFile(join(source, "example.txt"), "second\nthird\n")
  await git(source, "commit", "--quiet", "-am", "head")
  const { stdout: headOutput } = await git(source, "rev-parse", "HEAD")
  const headSha = headOutput.trim()

  const result = await prepareGitFixture({
    source,
    base: baseSha,
    head: headSha,
    name: "linux",
    cacheDirectory,
  })

  assert.equal(result.manifest.baseSha, baseSha)
  assert.equal(result.manifest.headSha, headSha)
  assert.deepEqual(result.manifest.scale, {
    addedRows: 2,
    binaryFiles: 0,
    changedFiles: 1,
    deletedRows: 1,
  })
  assert.match(result.manifest.id, /^linux-[a-f0-9]{12}$/)
  assert.deepEqual(JSON.parse(await readFile(result.manifestPath, "utf8")), result.manifest)

  const repeated = await prepareGitFixture({
    source,
    base: baseSha,
    head: headSha,
    name: "linux",
    cacheDirectory,
  })
  assert.equal(repeated.fixtureDirectory, result.fixtureDirectory)
  assert.deepEqual(repeated.manifest, result.manifest)

  await assert.rejects(
    prepareGitFixture({
      source,
      base: baseSha,
      head: headSha,
      name: "../outside",
      cacheDirectory,
    }),
    /Fixture name must contain only/,
  )
})
