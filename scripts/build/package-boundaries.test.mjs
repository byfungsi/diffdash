import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import test from "node:test"

import { build } from "esbuild"

const root = resolve(import.meta.dirname, "../..")
const workspaceDirectories = ["packages", "tools"].flatMap((parent) =>
  readdirSync(join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, parent, entry.name)),
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
const browserSafePackages = new Set([
  "@diffdash/agent-provider",
  "@diffdash/app",
  "@diffdash/domain",
  "@diffdash/git-provider",
  "@diffdash/protocol",
])
const concreteProviderPattern = /^@diffdash\/(?:agent-provider|git-provider)-/

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

test("workspace package dependencies are acyclic", () => {
  const graph = new Map(
    manifests.map(({ manifest }) => [
      manifest.name,
      Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) =>
        name.startsWith("@diffdash/"),
      ),
    ]),
  )
  const visited = new Set()
  const active = new Set()

  const visit = (name, path) => {
    if (active.has(name)) {
      const cycleStart = path.indexOf(name)
      assert.fail(`workspace dependency cycle: ${[...path.slice(cycleStart), name].join(" -> ")}`)
    }
    if (visited.has(name)) return
    active.add(name)
    for (const dependency of graph.get(name) ?? []) visit(dependency, [...path, name])
    active.delete(name)
    visited.add(name)
  }

  for (const name of graph.keys()) visit(name, [])
})

test("concrete Git providers remain isolated leaf integrations", () => {
  const providers = manifests.filter(({ manifest }) =>
    manifest.name.startsWith("@diffdash/git-provider-"),
  )
  const names = new Set(providers.map(({ manifest }) => manifest.name))
  assert.ok(names.has("@diffdash/git-provider-fixture"))
  assert.ok(names.has("@diffdash/git-provider-github"))
  for (const provider of providers) {
    assert.ok(
      Object.keys(provider.manifest.dependencies).includes("@diffdash/git-provider"),
      `${provider.manifest.name} must depend on the provider SDK`,
    )
    const source = sourceFiles(join(provider.directory, "src"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
    assert.doesNotMatch(
      source,
      /(?:from\s*|import\s*\()(["'])(?:electron|react|better-sqlite3|@diffdash\/(?:app|desktop|persistence|protocol|settings)|@diffdash\/git-provider-[^"']+)(?:\/[^"']*)?\1/,
      `${provider.manifest.name} crosses the provider leaf boundary`,
    )
  }
})

test("only desktop composition imports a concrete Git provider", () => {
  const allowedComposition = resolve(root, "packages/desktop/electron/main/composition.ts")
  for (const { directory, manifest } of manifests) {
    if (manifest.name.startsWith("@diffdash/git-provider-")) continue
    const source = join(directory, "src")
    let files = []
    try {
      files = sourceFiles(source)
    } catch {
      continue
    }
    if (manifest.name === "@diffdash/desktop") {
      files.push(...sourceFiles(join(directory, "electron")))
    }
    for (const file of files) {
      if (resolve(file) === allowedComposition) continue
      assert.doesNotMatch(
        readFileSync(file, "utf8"),
        /["']@diffdash\/git-provider-[^"']+(?:\/[^"']*)?["']/,
        `${file} imports a concrete Git provider outside desktop composition`,
      )
    }
  }
})

test("Electron IPC controllers do not access repository persistence directly", () => {
  const controllers = sourceFiles(join(root, "packages/desktop/electron/main/ipc/controllers"))
  for (const file of controllers) {
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      /["']@diffdash\/persistence\/repository-store["']/,
      `${file} must resolve repositories through a main-process service`,
    )
  }
})

test("agent providers remain isolated leaf integrations", () => {
  const sdk = manifests.find(({ manifest }) => manifest.name === "@diffdash/agent-provider")
  assert.ok(sdk, "@diffdash/agent-provider must exist")
  assert.deepEqual(Object.keys(sdk.manifest.dependencies), ["effect"])

  const providers = manifests.filter(({ manifest }) =>
    manifest.name.startsWith("@diffdash/agent-provider-"),
  )
  for (const provider of providers) {
    assert.ok(
      Object.keys(provider.manifest.dependencies).includes("@diffdash/agent-provider"),
      `${provider.manifest.name} must depend on the agent provider SDK`,
    )
    const source = sourceFiles(join(provider.directory, "src"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
    assert.doesNotMatch(
      source,
      /(?:from\s*|import\s*\()(["'])(?:electron|react|better-sqlite3|@diffdash\/(?:app|desktop|domain|git-provider|persistence|protocol|settings)|@diffdash\/agent-provider-[^"']+)(?:\/[^"']*)?\1/,
      `${provider.manifest.name} crosses the agent provider leaf boundary`,
    )
  }
})

test("protocol may reuse only the browser-safe agent provider SDK boundary", () => {
  const protocol = manifests.find(({ manifest }) => manifest.name === "@diffdash/protocol")
  assert.ok(protocol, "@diffdash/protocol must exist")
  assert.equal(protocol.manifest.dependencies["@diffdash/agent-provider"], "workspace:*")
  const source = sourceFiles(join(protocol.directory, "src"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
  assert.doesNotMatch(source, /["']@diffdash\/agent-provider-(?:[^"']+)["']/)
})

test("provider manifests remain platform-neutral leaves", () => {
  const forbiddenDependencies = new Set([
    "@diffdash/app",
    "@diffdash/desktop",
    "@diffdash/persistence",
    "@diffdash/settings",
    "better-sqlite3",
    "electron",
    "electron-updater",
    "react",
    "react-dom",
  ])

  for (const { manifest } of manifests.filter(({ manifest: candidate }) =>
    concreteProviderPattern.test(candidate.name),
  )) {
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      assert.ok(
        !forbiddenDependencies.has(dependency),
        `${manifest.name} cannot depend on ${dependency}`,
      )
      assert.ok(
        !concreteProviderPattern.test(dependency),
        `${manifest.name} cannot depend on concrete provider ${dependency}`,
      )
    }
  }
})

test("only the desktop agent composition imports concrete agent providers", () => {
  const allowedComposition = resolve(
    root,
    "packages/desktop/electron/main/agent-provider-composition.ts",
  )
  for (const { directory, manifest } of manifests) {
    if (manifest.name.startsWith("@diffdash/agent-provider-")) continue
    const source = join(directory, "src")
    let files = []
    try {
      files = sourceFiles(source)
    } catch {
      // Packages without source directories do not participate.
    }
    if (manifest.name === "@diffdash/desktop") {
      files.push(...sourceFiles(join(directory, "electron")))
    }
    for (const file of files) {
      if (resolve(file) === allowedComposition) continue
      assert.doesNotMatch(
        readFileSync(file, "utf8"),
        /["']@diffdash\/agent-provider-[^"']+(?:\/[^"']*)?["']/,
        `${file} imports a concrete agent provider outside desktop composition`,
      )
    }
  }
})

test("agent provider SDK and registry import no concrete provider", () => {
  const sdkSource = sourceFiles(join(root, "packages/agent-provider/src"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
  assert.doesNotMatch(sdkSource, /["']@diffdash\/agent-provider-[^"']+(?:\/[^"']*)?["']/)
})

test("walkthrough orchestration is provider-neutral", () => {
  const walkthrough = manifests.find(({ manifest }) => manifest.name === "@diffdash/walkthrough")
  assert.ok(walkthrough, "@diffdash/walkthrough must exist")
  assert.ok(
    Object.hasOwn(walkthrough.manifest.dependencies, "@diffdash/agent-provider"),
    "@diffdash/walkthrough must depend on the agent provider SDK",
  )
  const source = sourceFiles(join(walkthrough.directory, "src"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
  assert.doesNotMatch(source, /["']@diffdash\/agent-provider-[^"']+(?:\/[^"']*)?["']/)
})

test("review-agent owns provider-neutral host orchestration", () => {
  const reviewAgent = manifests.find(({ manifest }) => manifest.name === "@diffdash/review-agent")
  assert.ok(reviewAgent, "@diffdash/review-agent must exist")
  for (const dependency of [
    "@diffdash/agent-provider",
    "@diffdash/git-provider",
    "@diffdash/local-git",
    "@diffdash/persistence",
  ]) {
    assert.ok(
      Object.hasOwn(reviewAgent.manifest.dependencies, dependency),
      `@diffdash/review-agent must own ${dependency} orchestration`,
    )
  }
  const source = sourceFiles(join(reviewAgent.directory, "src"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
  assert.doesNotMatch(source, /["']@diffdash\/agent-provider-[^"']+(?:\/[^"']*)?["']/)
  assert.doesNotMatch(source, /["'](?:electron|@diffdash\/settings)(?:\/[^"']*)?["']/)
})

test("the OpenCode SDK is owned only by its leaf provider", () => {
  for (const { directory, manifest } of manifests) {
    const ownsSdk = Object.hasOwn(manifest.dependencies ?? {}, "@opencode-ai/sdk")
    assert.equal(
      ownsSdk,
      manifest.name === "@diffdash/agent-provider-opencode",
      `${manifest.name} must not own the OpenCode SDK dependency`,
    )
    if (manifest.name === "@diffdash/agent-provider-opencode") continue
    const source = join(directory, "src")
    let files = []
    try {
      files = sourceFiles(source)
    } catch {
      continue
    }
    assert.doesNotMatch(
      files.map((file) => readFileSync(file, "utf8")).join("\n"),
      /["']@opencode-ai\/sdk(?:\/[^"']*)?["']/,
      `${manifest.name} imports the OpenCode SDK outside its provider package`,
    )
  }
})

test("every browser-safe package export bundles without platform dependencies", async () => {
  const entryPoints = manifests
    .filter(({ manifest }) => browserSafePackages.has(manifest.name))
    .flatMap(({ directory, manifest }) =>
      Object.values(manifest.exports)
        .filter((exportPath) => typeof exportPath === "string" && !exportPath.endsWith(".css"))
        .map((exportPath) => ({
          entryPoint: relative(root, resolve(directory, exportPath)),
          packageName: manifest.name,
        })),
    )

  await Promise.all(
    entryPoints.map(({ entryPoint, packageName }) =>
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
                assert.ok(
                  !concreteProviderPattern.test(path),
                  `${entryPoint} imports concrete provider ${path}`,
                )
                assert.ok(
                  !/^@diffdash\/(?:desktop|persistence|process)(?:\/|$)/.test(path),
                  `${entryPoint} imports platform package ${path}`,
                )
                if (!path.startsWith("@diffdash/")) return { external: true }
                return undefined
              })
            },
          },
        ],
        write: false,
      }).catch((error) => {
        throw new Error(`${packageName} export ${entryPoint} is not browser-safe`, { cause: error })
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
