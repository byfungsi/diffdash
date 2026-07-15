import { describe, expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceCli = join(projectRoot, "bin", "diffdash.mjs")
const packagedClis = [
  join(projectRoot, "resources", "darwin", "bin", "diffdash"),
  join(projectRoot, "resources", "linux", "bin", "diffdash"),
] as const

const runSourceCli = (args: ReadonlyArray<string>, cwd = projectRoot) =>
  spawnSync(process.execPath, [sourceCli, ...args], { cwd, encoding: "utf8" })

const runPackagedCli = (cli: string, args: ReadonlyArray<string>) =>
  spawnSync("/bin/sh", [cli, ...args], { encoding: "utf8" })

const waitForCapture = (capturePath: string): Promise<ReadonlyArray<string>> => {
  const readCapture = (attempt: number): Promise<ReadonlyArray<string>> => {
    if (existsSync(capturePath)) {
      return Promise.resolve(readFileSync(capturePath, "utf8").trimEnd().split("\n"))
    }

    if (attempt >= 500) {
      return Promise.reject(new Error("Timed out waiting for the fake Electron launch"))
    }

    return new Promise((resolveWait) => setTimeout(resolveWait, 10)).then(() =>
      readCapture(attempt + 1),
    )
  }

  return readCapture(0)
}

describe("diffdash CLI", () => {
  it("documents install in source and packaged help", () => {
    const sourceResult = runSourceCli(["--help"])
    expect(sourceResult.status).toBe(0)
    expect(sourceResult.stdout).toContain("diffdash install [path]")
    expect(sourceResult.stdout).toContain("diffdash --install-cli [directory]")

    for (const cli of packagedClis) {
      const result = runPackagedCli(cli, ["--help"])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("diffdash install [path]")
    }
  })

  it("forwards source commands and invocation cwd through the versioned envelope", async () => {
    const harnessRoot = mkdtempSync(join(tmpdir(), "diffdash-source-cli-test-"))

    try {
      const cli = join(harnessRoot, "bin", "diffdash.mjs")
      const mainEntry = join(harnessRoot, "out", "main", "index.js")
      const electronPackage = join(harnessRoot, "node_modules", "electron")
      const fakeElectron = join(harnessRoot, "fake-electron")
      const capturePath = join(harnessRoot, "launch-args")
      const workingDirectory = join(harnessRoot, "working-directory")

      mkdirSync(dirname(cli), { recursive: true })
      mkdirSync(dirname(mainEntry), { recursive: true })
      mkdirSync(electronPackage, { recursive: true })
      mkdirSync(workingDirectory)
      copyFileSync(sourceCli, cli)
      writeFileSync(mainEntry, "", "utf8")
      writeFileSync(
        join(electronPackage, "package.json"),
        JSON.stringify({
          exports: { ".": "./index.js", "./package.json": "./package.json" },
          type: "module",
          version: "43.0.0",
        }),
        "utf8",
      )
      writeFileSync(
        join(electronPackage, "index.js"),
        `export default ${JSON.stringify(fakeElectron)}\n`,
        "utf8",
      )
      writeFileSync(
        fakeElectron,
        '#!/bin/sh\nif [ "${1:-}" = "-e" ]; then exit 0; fi\nprintf \'%s\\n\' "$@" > "$DIFFDASH_TEST_CAPTURE"\n',
        "utf8",
      )
      chmodSync(fakeElectron, 0o755)

      const resolvedHarnessRoot = realpathSync(harnessRoot)
      const resolvedWorkingDirectory = realpathSync(workingDirectory)

      const runHarness = async (args: ReadonlyArray<string>) => {
        rmSync(capturePath, { force: true })
        const result = spawnSync(process.execPath, [cli, ...args], {
          cwd: workingDirectory,
          encoding: "utf8",
          env: { ...process.env, DIFFDASH_TEST_CAPTURE: capturePath },
        })
        expect(result.status).toBe(0)
        return waitForCapture(capturePath)
      }

      await expect(runHarness(["changes"])).resolves.toEqual([
        resolvedHarnessRoot,
        `--diffdash-cli-v1=${resolvedWorkingDirectory}`,
        "--",
        "changes",
      ])
      await expect(runHarness(["install", "linked-project"])).resolves.toEqual([
        resolvedHarnessRoot,
        `--diffdash-cli-v1=${resolvedWorkingDirectory}`,
        "--",
        "install",
        "linked-project",
      ])
      await expect(runHarness(["pr", "42"])).resolves.toEqual([
        resolvedHarnessRoot,
        `--diffdash-cli-v1=${resolvedWorkingDirectory}`,
        "--",
        "pr",
        "42",
      ])
    } finally {
      rmSync(harnessRoot, { force: true, recursive: true })
    }
  })

  it("forwards packaged commands without parsing them in the launcher", async () => {
    const harnessRoot = mkdtempSync(join(tmpdir(), "diffdash-packaged-cli-test-"))
    const harnesses = [
      {
        app: join(harnessRoot, "darwin", "Contents", "MacOS", "DiffDash"),
        cli: join(harnessRoot, "darwin", "Contents", "Resources", "bin", "diffdash"),
        source: packagedClis[0],
      },
      {
        app: join(harnessRoot, "linux", "diffdash-desktop"),
        cli: join(harnessRoot, "linux", "resources", "bin", "diffdash"),
        source: packagedClis[1],
      },
    ]

    try {
      await Promise.all(
        harnesses.map(async (harness, index) => {
          const capturePath = join(harnessRoot, `packaged-launch-args-${index}`)
          const workingDirectory = join(harnessRoot, `working-directory-${index}`)
          mkdirSync(dirname(harness.cli), { recursive: true })
          mkdirSync(dirname(harness.app), { recursive: true })
          mkdirSync(workingDirectory)
          copyFileSync(harness.source, harness.cli)
          writeFileSync(
            harness.app,
            '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$DIFFDASH_TEST_CAPTURE"\n',
            "utf8",
          )
          chmodSync(harness.app, 0o755)

          const result = spawnSync("/bin/sh", [harness.cli, "install", "linked-project"], {
            cwd: workingDirectory,
            encoding: "utf8",
            env: { ...process.env, DIFFDASH_TEST_CAPTURE: capturePath },
          })

          expect(result.status).toBe(0)
          await expect(waitForCapture(capturePath)).resolves.toEqual([
            `--diffdash-cli-v1=${realpathSync(workingDirectory)}`,
            "--",
            "install",
            "linked-project",
          ])
        }),
      )
    } finally {
      rmSync(harnessRoot, { force: true, recursive: true })
    }
  })

  it("preserves source --install-cli", () => {
    const directory = mkdtempSync(join(tmpdir(), "diffdash-install-cli-test-"))

    try {
      const targetDirectory = join(directory, "bin")
      const result = runSourceCli(["--install-cli", targetDirectory])
      const installedCli = join(targetDirectory, "diffdash")

      expect(result.status).toBe(0)
      expect(realpathSync(installedCli)).toBe(realpathSync(sourceCli))
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
