import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"

import { generateSyntheticFixture } from "../src/synthetic-fixture.mjs"

const execFilePromise = promisify(execFile)

const git = (repository, ...args) =>
  execFilePromise("git", args, { cwd: repository, maxBuffer: 1024 * 1024 })

const gitBuffer = (repository, ...args) =>
  execFilePromise("git", args, {
    cwd: repository,
    encoding: "buffer",
    maxBuffer: 1024 * 1024,
  })

const parseNameStatuses = (output) => {
  const fields = output.split("\0")
  const statuses = []
  for (let index = 0; index < fields.length - 1; ) {
    const status = fields[index]
    const firstPath = fields[index + 1]
    index += 2
    if (status.startsWith("R")) {
      statuses.push([status, firstPath, fields[index]])
      index += 1
    } else {
      statuses.push([status, firstPath])
    }
  }
  return statuses
}

test("generates every scale scenario without network access", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "diffdash-synthetic-scale-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  const profile = { fileCount: 10, rowCount: 14, enormousFileRows: 5, wrappedLineBytes: 64 }
  const result = await generateSyntheticFixture({
    directory: join(root, "repository"),
    profile,
  })

  assert.equal(result.manifest.version, 2)
  assert.deepEqual(result.manifest.scale, {
    addedRows: 14,
    binaryFiles: 1,
    changedFiles: 10,
    deletedRows: 2,
  })
  assert.deepEqual(Object.keys(result.manifest.scenarios), [
    "annotation",
    "binary",
    "broadSearch",
    "delete",
    "denseThread",
    "enormousFile",
    "executableModeChange",
    "noNewline",
    "rename",
    "revisionChange",
    "wrappedLine",
  ])
  const { stdout: numstat } = await git(
    result.repository,
    "diff",
    "--numstat",
    "-M",
    result.manifest.baseSha,
    result.manifest.headSha,
  )
  const scale = numstat
    .trim()
    .split("\n")
    .reduce(
      (totals, line) => {
        const [added, deleted] = line.split("\t", 2)
        totals.changedFiles += 1
        if (added === "-" || deleted === "-") totals.binaryFiles += 1
        else {
          totals.addedRows += Number(added)
          totals.deletedRows += Number(deleted)
        }
        return totals
      },
      { addedRows: 0, binaryFiles: 0, changedFiles: 0, deletedRows: 0 },
    )
  assert.deepEqual(scale, result.manifest.scale)

  const { stdout: nameStatus } = await git(
    result.repository,
    "diff",
    "--name-status",
    "-z",
    "-M",
    result.manifest.baseSha,
    result.manifest.headSha,
  )
  assert.deepEqual(parseNameStatuses(nameStatus), [
    ["A", "fixture/000/00000.txt"],
    ["A", "fixture/000/00001.txt"],
    ["A", "fixture/000/00002.txt"],
    ["A", "fixture/000/00003.txt"],
    ["A", "fixture/000/00009.txt"],
    ["M", "fixture/scenarios/binary.bin"],
    ["D", "fixture/scenarios/deleted.txt"],
    ["M", "fixture/scenarios/executable.sh"],
    ["M", "fixture/scenarios/no-newline.txt"],
    ["R100", "fixture/scenarios/rename-source.txt", "fixture/scenarios/renamed-target.txt"],
  ])

  const { stdout: rawMode } = await git(
    result.repository,
    "diff",
    "--raw",
    result.manifest.baseSha,
    result.manifest.headSha,
    "--",
    result.manifest.scenarios.executableModeChange,
  )
  assert.match(rawMode, /^:100644 100755 ([a-f0-9]+) \1 M\t/u)

  const { stdout: binaryBase } = await gitBuffer(
    result.repository,
    "show",
    `${result.manifest.baseSha}:${result.manifest.scenarios.binary}`,
  )
  const { stdout: binaryHead } = await gitBuffer(
    result.repository,
    "show",
    `${result.manifest.headSha}:${result.manifest.scenarios.binary}`,
  )
  assert.deepEqual(binaryBase, Buffer.from([0x00, 0x44, 0x49, 0x46, 0x46, 0x42, 0x41, 0x53, 0x45]))
  assert.deepEqual(binaryHead, Buffer.from([0x00, 0x44, 0x49, 0x46, 0x46, 0x48, 0x45, 0x41, 0x44]))

  const { stdout: noNewlineHead } = await gitBuffer(
    result.repository,
    "show",
    `${result.manifest.headSha}:${result.manifest.scenarios.noNewline}`,
  )
  assert.equal(
    noNewlineHead.toString("utf8"),
    "no-newline row=0000000 value=head\nno-newline row=0000001 value=head",
  )
  assert.notEqual(noNewlineHead.at(-1), 0x0a)
  const { stdout: noNewlineDiff } = await git(
    result.repository,
    "diff",
    result.manifest.baseSha,
    result.manifest.headSha,
    "--",
    result.manifest.scenarios.noNewline,
  )
  assert.equal(noNewlineDiff.match(/\\ No newline at end of file/gu)?.length, 2)

  const { stdout: renamedBase } = await git(
    result.repository,
    "show",
    `${result.manifest.baseSha}:${result.manifest.scenarios.rename.from}`,
  )
  const { stdout: renamedHead } = await git(
    result.repository,
    "show",
    `${result.manifest.headSha}:${result.manifest.scenarios.rename.to}`,
  )
  assert.equal(renamedBase, "pure rename fixture\n")
  assert.equal(renamedHead, renamedBase)
  const { stdout: deletedBase } = await git(
    result.repository,
    "show",
    `${result.manifest.baseSha}:${result.manifest.scenarios.delete}`,
  )
  assert.equal(deletedBase, "deleted in head\n")
  await assert.rejects(
    git(
      result.repository,
      "cat-file",
      "-e",
      `${result.manifest.headSha}:${result.manifest.scenarios.delete}`,
    ),
  )

  const { stdout: annotation } = await git(
    result.repository,
    "show",
    `${result.manifest.headSha}:${result.manifest.scenarios.annotation}`,
  )
  const { stdout: denseThread } = await git(
    result.repository,
    "show",
    `${result.manifest.headSha}:${result.manifest.scenarios.denseThread}`,
  )
  const { stdout: revisedAnnotation } = await git(
    result.repository,
    "show",
    `${result.manifest.revisionSha}:${result.manifest.scenarios.annotation}`,
  )
  assert.match(annotation, /^annotation-anchor /u)
  assert.match(denseThread, /^dense-thread-anchor /u)
  assert.equal(revisedAnnotation, "annotation-anchor moved by revision change\n")
  assert.match(result.manifest.id, /^pathological-[a-f0-9]{16}$/u)
  assert.match(await readFile(result.manifestPath, "utf8"), /synthetic-repository-scale/)

  const repeated = await generateSyntheticFixture({
    directory: join(root, "repeated-repository"),
    profile,
  })
  assert.deepEqual(repeated.manifest, result.manifest)
  const { stdout: repeatedTree } = await git(
    repeated.repository,
    "rev-parse",
    `${repeated.manifest.headSha}^{tree}`,
  )
  const { stdout: originalTree } = await git(
    result.repository,
    "rev-parse",
    `${result.manifest.headSha}^{tree}`,
  )
  assert.equal(repeatedTree, originalTree)
})

test("rejects profiles that cannot preserve scenario and row-count semantics", async () => {
  await assert.rejects(
    generateSyntheticFixture({
      directory: "unused",
      profile: { fileCount: 9, rowCount: 14, enormousFileRows: 5, wrappedLineBytes: 64 },
    }),
    /fileCount must leave room/u,
  )
  await assert.rejects(
    generateSyntheticFixture({
      directory: "unused",
      profile: { fileCount: 10, rowCount: 9, enormousFileRows: 5, wrappedLineBytes: 64 },
    }),
    /rowCount cannot be distributed/u,
  )
})
