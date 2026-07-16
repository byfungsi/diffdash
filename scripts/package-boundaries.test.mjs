import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import test from "node:test"

import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")
const workspaceDirectories = ["packages", "tools"].flatMap((parent) =>
  readdirSync(join(root, parent)).map((name) => join(root, parent, name)),
)
const manifests = workspaceDirectories.map((directory) => ({
  directory,
  manifest: JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
}))
const forbiddenBrowserImports = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "better-sqlite3",
  "electron",
  "electron-updater",
])

const sourceFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : []
  })

test("workspace packages expose local verification contracts", () => {
  for (const { manifest } of manifests) {
    assert.equal(manifest.private, true, `${manifest.name} must remain private`)
    assert.ok(manifest.exports !== undefined, `${manifest.name} must declare explicit exports`)
    for (const script of ["build", "typecheck", "test", "lint"]) {
      assert.equal(typeof manifest.scripts?.[script], "string", `${manifest.name} needs ${script}`)
    }
    for (const dependencies of [manifest.dependencies, manifest.devDependencies]) {
      for (const [name, version] of Object.entries(dependencies ?? {})) {
        if (name.startsWith("@diffdash/")) {
          assert.equal(version, "workspace:*", `${manifest.name} must use workspace:* for ${name}`)
        }
      }
    }
  }
})

test("relative imports stay inside their package", () => {
  const importPattern = /(?:from\s*|import\s*\()(["'])(\.\.?\/[^"']+)\1/g
  for (const { directory } of manifests) {
    const source = join(directory, "src")
    if (!statSync(directory).isDirectory()) continue
    let files = []
    try {
      files = sourceFiles(source)
    } catch {
      continue
    }
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(importPattern)) {
        const target = resolve(dirname(file), match[2])
        assert.ok(
          !relative(directory, target).startsWith(".."),
          `${file} imports outside its package`,
        )
      }
    }
  }
})

test("GitHub provider remains an isolated leaf integration", () => {
  const github = manifests.find(({ manifest }) => manifest.name === "@diffdash/git-provider-github")
  assert.ok(github, "GitHub provider package must exist")
  assert.deepEqual(Object.keys(github.manifest.dependencies).toSorted(), [
    "@diffdash/git-provider",
    "@diffdash/process",
    "effect",
  ])
  const source = sourceFiles(join(github.directory, "src"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
  assert.doesNotMatch(
    source,
    /(?:from\s*|import\s*\()(["'])(?:electron|react|better-sqlite3|@diffdash\/(?:app|desktop|persistence|settings))(?:\/[^"']*)?\1/,
  )
})

test("browser packages bundle without platform dependencies", async () => {
  await Promise.all(
    [
      "packages/domain/src/repository.ts",
      "packages/git-provider/src/registry.ts",
      "packages/protocol/src/api.ts",
      "packages/app/src/index.ts",
    ].map((entryPoint) =>
      build({
        absWorkingDir: root,
        bundle: true,
        entryPoints: [entryPoint],
        logLevel: "silent",
        platform: "browser",
        plugins: [
          {
            name: "browser-boundary",
            setup(buildApi) {
              buildApi.onResolve({ filter: /^[^.]/ }, (args) => {
                const path = args.path.replace(/\?.*$/, "")
                assert.ok(!forbiddenBrowserImports.has(path), `${entryPoint} imports ${path}`)
                if (!path.startsWith("@diffdash/")) return { external: true }
                return undefined
              })
            },
          },
        ],
        write: false,
      }),
    ),
  )
})

test("the workspace resolves one Effect runtime", () => {
  const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8")
  const effectVersions = new Set(
    [...lockfile.matchAll(/^  effect@([^:]+):/gm)].map((match) => match[1]),
  )
  assert.equal(effectVersions.size, 1)
  assert.doesNotMatch(lockfile, /^  ['"]?@effect\/schema@/m)
})
