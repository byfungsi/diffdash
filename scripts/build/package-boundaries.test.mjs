import assert from "node:assert/strict"
import {
  globSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { builtinModules } from "node:module"
import { tmpdir } from "node:os"
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
  "@diffdash/agents",
  "@diffdash/app",
  "@diffdash/domain",
  "@diffdash/git-provider",
  "@diffdash/protocol",
])
const concreteProviderPattern = /^@diffdash\/(?:agent-provider|git-provider)-/
const strictProductionPackages = new Set([
  "@diffdash/domain",
  "@diffdash/protocol",
  "@diffdash/agent-provider",
  "@diffdash/agents",
  "@diffdash/git-provider",
  "@diffdash/core",
  "@diffdash/app",
  "@diffdash/web",
])
const explicitUnknownBoundaryFiles = new Set(["packages/agent-provider/src/provider-json.ts"])
const documentedPackageDependencies = new Map([
  ["@diffdash/domain", []],
  ["@diffdash/agent-provider", ["@diffdash/domain"]],
  ["@diffdash/protocol", ["@diffdash/domain"]],
  ["@diffdash/app", ["@diffdash/domain", "@diffdash/protocol"]],
  ["@diffdash/process", ["@diffdash/domain"]],
  ["@diffdash/settings", ["@diffdash/domain"]],
  ["@diffdash/persistence", ["@diffdash/domain"]],
  ["@diffdash/git-provider", ["@diffdash/domain"]],
  ["@diffdash/local-git", ["@diffdash/domain", "@diffdash/git-provider", "@diffdash/process"]],
  ["@diffdash/agents", ["@diffdash/agent-provider", "@diffdash/domain"]],
  ["@diffdash/mcp", ["@diffdash/domain", "@diffdash/protocol"]],
  [
    "@diffdash/core",
    [
      "@diffdash/agents",
      "@diffdash/agent-provider",
      "@diffdash/agent-provider-claude",
      "@diffdash/agent-provider-codex",
      "@diffdash/agent-provider-fixture",
      "@diffdash/agent-provider-opencode",
      "@diffdash/domain",
      "@diffdash/git-provider",
      "@diffdash/git-provider-fixture",
      "@diffdash/git-provider-github",
      "@diffdash/local-git",
      "@diffdash/mcp",
      "@diffdash/persistence",
      "@diffdash/process",
      "@diffdash/protocol",
      "@diffdash/settings",
    ],
  ],
  ["@diffdash/desktop", ["@diffdash/app", "@diffdash/core", "@diffdash/protocol"]],
  ["@diffdash/e2e", ["@diffdash/desktop"]],
  ["@diffdash/web", []],
  ["@diffdash/download-worker", []],
  ["@diffdash/demo", ["@diffdash/domain", "@diffdash/protocol"]],
  ["@diffdash/demo-video", ["@diffdash/app", "@diffdash/demo", "@diffdash/protocol"]],
])
const desktopErrorAdapterDependencies = new Map([
  [
    "packages/desktop/electron/main/ipc/walkthrough-public-error.ts",
    new Set([
      "@diffdash/agent-provider",
      "@diffdash/agents",
      "@diffdash/domain",
      "@diffdash/persistence",
      "@diffdash/process",
    ]),
  ],
  [
    "packages/desktop/electron/main/ipc/review-thread-public-error.ts",
    new Set(["@diffdash/agent-provider"]),
  ],
  ["packages/desktop/electron/main/ipc/public-error.ts", new Set(["@diffdash/domain"])],
])

const sourceFiles = (directory) =>
  globSync("**/*.{js,jsx,ts,tsx,mjs,mjsx,cjs,cjsx}", { cwd: directory })
    .map((file) => join(directory, file))
    .filter((file) => lstatSync(file).isFile())
    .toSorted()

const workspaceImportPattern = /(?:from\s*|import\s*\()(["'])(@diffdash\/[^/"']+)(?:\/[^"']*)?\1/g

const exportedUnknownOutputPatterns = [
  /\bexport\s+(?:default\s+)?(?:async\s+)?function\s*([\w$]*)[^;{}]*?\)\s*:\s*[^;{=]*\bunknown\b[^;{=]*\s*\{/g,
  /\bexport\s+(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*:\s*[^;=]*\bunknown\b[^;=]*=>/g,
  /\bexport\s+(?:const|let|var)\s+([\w$]+)\s*:\s*\([^)]*\)\s*=>\s*[^;=]*\bunknown\b[^;=]*=/g,
  /\bexport\s+(?:const|let|var)\s+([\w$]+)\s*:(?!\s*\()\s*[^;=]*\bunknown\b[^;=]*=/g,
]

const exportedUnknownOutputs = (source) => {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, "")
    .replace(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g, (literal) =>
      literal.replace(/[^\n]/g, " "),
    )
  return exportedUnknownOutputPatterns
    .flatMap((pattern) =>
      [...code.matchAll(pattern)].map((match) => ({ index: match.index, name: match[1] })),
    )
    .toSorted((left, right) => left.index - right.index)
    .map(({ name }) => name || "default function")
}

test("exported unknown output detection distinguishes inputs from erased outputs", () => {
  assert.deepEqual(
    exportedUnknownOutputs(`
      export const isRecord = (value: unknown): value is Record<string, string> => true
      export const typedGuard: (value: unknown) => value is string = (value) => true
      export function acceptsUnknown(value: unknown): string { return String(value) }
    `),
    [],
  )
  assert.deepEqual(
    exportedUnknownOutputs(`
      export const erasedValue: unknown = "value"
      export const erasedPromise = (): Promise<unknown> => Promise.resolve("value")
      export function erasedReturn(): unknown { return "value" }
    `),
    ["erasedValue", "erasedPromise", "erasedReturn"],
  )
})

test("native source discovery preserves nested supported extensions", () => {
  const directory = mkdtempSync(join(tmpdir(), "diffdash-boundaries-"))
  try {
    mkdirSync(join(directory, "nested", "deeper"), { recursive: true })
    for (const file of ["entry.ts", "nested/view.tsx", "nested/deeper/runtime.mjs"]) {
      writeFileSync(join(directory, file), "")
    }
    writeFileSync(join(directory, "nested/ignored.json"), "")
    assert.deepEqual(
      sourceFiles(directory).map((file) => relative(directory, file)),
      ["entry.ts", join("nested", "deeper", "runtime.mjs"), join("nested", "view.tsx")],
    )
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
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

test("source package imports follow the documented package dependency allowlist", () => {
  for (const { directory, manifest } of manifests) {
    const allowedDependencies = new Set(documentedPackageDependencies.get(manifest.name) ?? [])
    if (manifest.name.startsWith("@diffdash/git-provider-")) {
      allowedDependencies.add("@diffdash/git-provider")
      allowedDependencies.add("@diffdash/process")
    } else if (manifest.name.startsWith("@diffdash/agent-provider-")) {
      allowedDependencies.add("@diffdash/agent-provider")
      allowedDependencies.add("@diffdash/domain")
      allowedDependencies.add("@diffdash/process")
    } else {
      assert.ok(
        documentedPackageDependencies.has(manifest.name),
        `${manifest.name} needs an explicit documented package dependency allowlist`,
      )
    }

    let files = []
    try {
      files = sourceFiles(join(directory, "src"))
    } catch {
      // Packages without source directories do not participate.
    }
    if (manifest.name === "@diffdash/desktop") {
      files.push(...sourceFiles(join(directory, "electron")))
    }

    for (const file of files.filter((candidate) => !/\.test\.[cm]?[jt]sx?$/.test(candidate))) {
      const relativeFile = relative(root, file)
      const adapterDependencies = desktopErrorAdapterDependencies.get(relativeFile) ?? new Set()
      for (const match of readFileSync(file, "utf8").matchAll(workspaceImportPattern)) {
        const dependency = match[2]
        assert.ok(
          allowedDependencies.has(dependency) || adapterDependencies.has(dependency),
          `${relativeFile} imports undocumented package dependency ${dependency}`,
        )
      }
    }
  }

  for (const [file, dependencies] of desktopErrorAdapterDependencies) {
    const importedDependencies = new Set(
      [...readFileSync(resolve(root, file), "utf8").matchAll(workspaceImportPattern)].map(
        (match) => match[2],
      ),
    )
    assert.ok(
      [...dependencies].every((dependency) => importedDependencies.has(dependency)),
      `${file} no longer needs its temporary package dependency exception`,
    )
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

test("only Core composition imports a concrete Git provider", () => {
  const allowedCompositions = new Set([
    resolve(root, "packages/core/src/provider-composition.ts"),
    resolve(root, "packages/core/src/provider-composition.e2e.ts"),
  ])
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
      if (allowedCompositions.has(resolve(file))) continue
      assert.doesNotMatch(
        readFileSync(file, "utf8"),
        /["']@diffdash\/git-provider-[^"']+(?:\/[^"']*)?["']/,
        `${file} imports a concrete Git provider outside Core composition`,
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

test("renderer features access the preload bridge only through PreloadClient", () => {
  const appSourceDirectory = resolve(root, "packages/app/src")
  const allowedBridgeOwner = resolve(appSourceDirectory, "platform/preload-client.ts")
  const directBridgePattern = /\bwindow(?:\.diffDash|\[["']diffDash["']\])/u

  for (const file of sourceFiles(appSourceDirectory)) {
    if (resolve(file) === allowedBridgeOwner) continue
    if (/\.test\.[cm]?[jt]sx?$/.test(file)) continue
    if (
      relative(appSourceDirectory, file).startsWith(
        `test${process.platform === "win32" ? "\\" : "/"}`,
      )
    ) {
      continue
    }
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      directBridgePattern,
      `${relative(appSourceDirectory, file)} bypasses renderer capability services`,
    )
  }

  assert.match(readFileSync(allowedBridgeOwner, "utf8"), directBridgePattern)
})

test("agent providers remain isolated leaf integrations", () => {
  const sdk = manifests.find(({ manifest }) => manifest.name === "@diffdash/agent-provider")
  assert.ok(sdk, "@diffdash/agent-provider must exist")
  assert.deepEqual(Object.keys(sdk.manifest.dependencies), ["@diffdash/domain", "effect"])

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
      /(?:from\s*|import\s*\()(["'])(?:electron|react|better-sqlite3|@diffdash\/(?:app|desktop|git-provider|persistence|protocol|settings)|@diffdash\/agent-provider-[^"']+)(?:\/[^"']*)?\1/,
      `${provider.manifest.name} crosses the agent provider leaf boundary`,
    )
  }
})

test("protocol depends only on browser-safe domain contracts", () => {
  const protocol = manifests.find(({ manifest }) => manifest.name === "@diffdash/protocol")
  assert.ok(protocol, "@diffdash/protocol must exist")
  assert.equal(protocol.manifest.dependencies["@diffdash/agent-provider"], undefined)
  const source = sourceFiles(join(protocol.directory, "src"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
  assert.doesNotMatch(source, /["']@diffdash\/agent-provider(?:-[^"']+)?(?:\/[^"']*)?["']/)
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

test("only Core composition imports concrete agent providers", () => {
  const allowedCompositions = new Set([
    resolve(root, "packages/core/src/provider-composition.ts"),
    resolve(root, "packages/core/src/provider-composition.e2e.ts"),
  ])
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
      if (allowedCompositions.has(resolve(file))) continue
      assert.doesNotMatch(
        readFileSync(file, "utf8"),
        /["']@diffdash\/agent-provider-[^"']+(?:\/[^"']*)?["']/,
        `${file} imports a concrete agent provider outside Core composition`,
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

test("agents package exposes provider-neutral walkthrough and review-thread engines", () => {
  const agents = manifests.find(({ manifest }) => manifest.name === "@diffdash/agents")
  assert.ok(agents, "@diffdash/agents must exist")
  assert.deepEqual(Object.keys(agents.manifest.exports), ["./walkthrough", "./review-thread"])
  assert.deepEqual(Object.keys(agents.manifest.dependencies), [
    "@diffdash/agent-provider",
    "@diffdash/domain",
    "effect",
  ])
  const source = sourceFiles(join(agents.directory, "src"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
  assert.ok(
    sourceFiles(join(agents.directory, "src")).includes(
      join(agents.directory, "src/review-thread-prompt.ts"),
    ),
    "@diffdash/agents must own review-thread prompt construction",
  )
  assert.doesNotMatch(source, /["']@diffdash\/agent-provider-[^"']+(?:\/[^"']*)?["']/)
  assert.doesNotMatch(
    source,
    /["'](?:electron|@diffdash\/(?:core|desktop|local-git|persistence|process)|@modelcontextprotocol\/sdk)(?:\/[^"']*)?["']/,
  )
})

test("Core owns review-agent support services", () => {
  assert.equal(
    manifests.some(({ manifest }) => manifest.name === "@diffdash/review-agent"),
    false,
    "the review-agent package must be consolidated into Core",
  )
  const core = manifests.find(({ manifest }) => manifest.name === "@diffdash/core")
  assert.ok(core, "@diffdash/core must exist")
  for (const file of [
    "agent-artifact-normalizer.ts",
    "offset-pagination.ts",
    "review-thread-anchor-mapper.ts",
  ]) {
    assert.ok(
      sourceFiles(join(core.directory, "src/services")).includes(
        join(core.directory, "src/services", file),
      ),
      `@diffdash/core must own services/${file}`,
    )
  }
  const source = sourceFiles(join(core.directory, "src"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
  assert.doesNotMatch(source, /["']@diffdash\/review-agent(?:\/[^"']*)?["']/)
  assert.ok(
    sourceFiles(join(root, "packages/domain/src")).includes(
      join(root, "packages/domain/src/review-ordering.ts"),
    ),
    "@diffdash/domain must own deterministic review ordering",
  )
})

test("the MCP SDK and adapter mechanics are owned only by @diffdash/mcp", () => {
  const mcp = manifests.find(({ manifest }) => manifest.name === "@diffdash/mcp")
  assert.ok(mcp, "@diffdash/mcp must exist")
  assert.equal(mcp.manifest.dependencies["@modelcontextprotocol/sdk"], "1.29.0")

  for (const { manifest, directory } of manifests) {
    if (manifest.name !== "@diffdash/mcp") {
      assert.equal(
        Object.hasOwn(manifest.dependencies ?? {}, "@modelcontextprotocol/sdk"),
        false,
        `${manifest.name} must not own the MCP SDK dependency`,
      )
    }
    let files = []
    try {
      files = sourceFiles(join(directory, "src"))
      if (manifest.name === "@diffdash/desktop")
        files.push(...sourceFiles(join(directory, "electron")))
    } catch {
      continue
    }
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n")
    if (manifest.name !== "@diffdash/mcp") {
      assert.doesNotMatch(source, /["']@modelcontextprotocol\/sdk(?:\/[^"']*)?["']/)
    }
  }

  const adapterSource = sourceFiles(join(mcp.directory, "src"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
  assert.doesNotMatch(
    adapterSource,
    /["']@diffdash\/(?:core|local-git|persistence|process)(?:\/[^"']*)?["']|ReviewThreadStore|AgentRunArtifactStore/,
    "@diffdash/mcp must route tool calls through its typed Core handler port",
  )
})

test("strict production packages do not expose explicit unknown types", () => {
  for (const { directory, manifest } of manifests) {
    if (!strictProductionPackages.has(manifest.name)) continue
    const source = sourceFiles(join(directory, "src"))
      .filter(
        (file) =>
          !/\.test\.[cm]?[jt]sx?$/.test(file) &&
          !explicitUnknownBoundaryFiles.has(relative(root, file)),
      )
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/(?:\\.|[^/\\\n])+\/[dgimsuvy]*/g, "")
      .replace(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g, "")
    assert.doesNotMatch(
      source,
      /(?:\bas\s+|\b(?:extends|implements)\s+|[<|&,=]\s*|:\s*)unknown\b(?!\s*:)/u,
      `${manifest.name} exposes an explicit unknown type outside an adapter boundary`,
    )
    assert.doesNotMatch(
      source,
      /\bSchema\.Unknown\b/u,
      `${manifest.name} must use Schema.Json or a concrete schema`,
    )
  }
})

test("exported source signatures do not erase values as unknown", () => {
  for (const { directory } of manifests) {
    let files = []
    try {
      files = sourceFiles(join(directory, "src"))
    } catch {
      continue
    }
    for (const file of files.filter((candidate) => !/\.test\.[cm]?[jt]sx?$/.test(candidate))) {
      const source = readFileSync(file, "utf8")
      assert.deepEqual(
        exportedUnknownOutputs(source, file),
        [],
        `${relative(root, file)} exposes an erased unknown output value`,
      )
    }
  }
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

test("Core remains runtime-neutral and owns the only application ManagedRuntime", () => {
  const coreDirectory = resolve(root, "packages/core")
  const coreSourceFiles = sourceFiles(join(coreDirectory, "src"))
  const coreSource = coreSourceFiles.map((file) => readFileSync(file, "utf8")).join("\n")
  assert.doesNotMatch(
    coreSource,
    /(?:from\s*|import\s*\()(["'])(?:electron|electron-updater|react|@diffdash\/(?:app|desktop))(?:\/[^"']*)?\1/,
    "@diffdash/core cannot import renderer or Electron host packages",
  )

  const managedRuntimeOwners = manifests.flatMap(({ directory, manifest }) => {
    let files = []
    try {
      files = sourceFiles(join(directory, "src"))
    } catch {
      // Packages without source directories do not participate.
    }
    if (manifest.name === "@diffdash/desktop") {
      files.push(...sourceFiles(join(directory, "electron")))
    }
    return files.filter(
      (file) =>
        !/\.test\.[cm]?[jt]sx?$/.test(file) &&
        readFileSync(file, "utf8").includes("ManagedRuntime.make("),
    )
  })
  assert.deepEqual(managedRuntimeOwners, [resolve(root, "packages/core/src/embedded-core.ts")])

  const stableCoreEntry = readFileSync(join(coreDirectory, "src/core.ts"), "utf8")
  assert.doesNotMatch(stableCoreEntry, /runLegacy|ManagedRuntime|Layer/)
  assert.match(stableCoreEntry, /export \* from ["']\.\/core-contract["']/)

  const coreContract = readFileSync(join(coreDirectory, "src/core-contract.ts"), "utf8")
  assert.match(coreContract, /interface CoreOperationFailureMap/)
  assert.match(coreContract, /CoreResult<\s*CoreOperationOutput<Method>/)

  for (const sourceFile of coreSourceFiles.filter(
    (candidate) => !/\.test\.[cm]?[jt]sx?$/.test(candidate),
  )) {
    const source = readFileSync(sourceFile, "utf8")
    if (sourceFile !== resolve(coreDirectory, "src/core.ts")) {
      assert.doesNotMatch(
        source,
        /from ["']\.\.?\/core["']/,
        `${relative(coreDirectory, sourceFile)} imports the public Core entrypoint internally`,
      )
    }
    assert.doesNotMatch(
      source,
      /["']@diffdash\/protocol\/transport-error["']/,
      `${relative(coreDirectory, sourceFile)} creates transport-owned failures inside Core`,
    )
  }

  const coreOperationService = readFileSync(
    join(coreDirectory, "src/core-operation-service.ts"),
    "utf8",
  )
  assert.doesNotMatch(
    coreOperationService,
    /, unknown>/,
    "Core operation Effect channels must preserve expected failure types",
  )
})

test("persistence stores depend only on the generic Effect SQL client", () => {
  const persistenceDirectory = resolve(root, "packages/persistence")
  const runtimeAdapters = new Set([
    resolve(persistenceDirectory, "src/database-node.ts"),
    resolve(persistenceDirectory, "src/database-bun.ts"),
  ])

  for (const file of sourceFiles(join(persistenceDirectory, "src"))) {
    const source = readFileSync(file, "utf8")
    assert.doesNotMatch(source, /["']better-sqlite3(?:\/[^"']*)?["']/)
    if (runtimeAdapters.has(resolve(file)) || /\.test\.[cm]?[jt]sx?$/.test(file)) continue
    assert.doesNotMatch(
      source,
      /["']@effect\/sql-sqlite-(?:node|bun)(?:\/[^"']*)?["']/,
      `${relative(persistenceDirectory, file)} selects a concrete SQLite runtime outside its adapter`,
    )
  }

  const coreLayer = readFileSync(resolve(root, "packages/core/src/core-layer.ts"), "utf8")
  assert.doesNotMatch(coreLayer, /@diffdash\/persistence\/database-(?:node|bun)/)
})

test("Electron controllers consume only the closed Core operation boundary", () => {
  const desktopDirectory = resolve(root, "packages/desktop")
  const desktopSource = [
    ...sourceFiles(join(desktopDirectory, "src")),
    ...sourceFiles(join(desktopDirectory, "electron")),
  ]
  for (const file of desktopSource) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /@diffdash\/core\/legacy|runLegacy/)
  }

  const controllerDirectory = join(desktopDirectory, "electron/main/ipc/controllers")
  for (const file of sourceFiles(controllerDirectory)) {
    const source = readFileSync(file, "utf8")
    assert.doesNotMatch(source, /runtime\.runPromise/)
    assert.doesNotMatch(
      source,
      /from ["']@diffdash\/(?:local-git|persistence|settings|walkthrough)(?:\/[^"']*)?["']/,
      `${relative(desktopDirectory, file)} imports a Core-owned business service`,
    )
  }
})
