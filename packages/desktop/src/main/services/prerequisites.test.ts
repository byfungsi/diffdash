import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { AppConfig } from "./app-config"
import { CliError, CliService, type CliResult } from "@diffdash/process/cli"
import {
  Prerequisites,
  refreshAppImageCliLaunchers,
  resolveExecutableInPath,
} from "./prerequisites"
import { GitProvider } from "./git-provider"
import { AgentProviders } from "./agent-providers"
import {
  AgentProviderAutoCandidates,
  AgentProviderCapabilityStatus,
  AgentProviderCatalog,
  AgentProviderDefaults,
  AgentProviderStatus,
} from "@diffdash/protocol/agent-providers"
import {
  GitProviderCapabilities,
  GitProviderDescriptor,
  GitProviderDiagnostic,
  GitProviderId,
  GitProviderKind,
  GitProviderTerminology,
} from "@diffdash/domain/git-provider"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-prerequisites-test-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const unavailableProviderMethod = <A>() =>
  Effect.die(new Error("Unused provider method")) as Effect.Effect<A>

const withPath = (path: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.PATH
      process.env.PATH = path
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env.PATH
        } else {
          process.env.PATH = previous
        }
      }),
  )

const withHome = (path: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.HOME
      process.env.HOME = path
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env.HOME
        } else {
          process.env.HOME = previous
        }
      }),
  )

const waitForFile = async (path: string, attempts = 500): Promise<void> => {
  if (existsSync(path) || attempts === 0) return
  await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  return waitForFile(path, attempts - 1)
}

const makeLayer = (
  directory: string,
  options: {
    readonly availableCommands: ReadonlySet<string>
    readonly appImagePath?: string
    readonly diffDashCliPath?: string
    readonly ghAuthenticated?: boolean
    readonly ghSearchRepositoriesAvailable?: boolean
    readonly ghVersion?: string
  },
) =>
  Prerequisites.layer.pipe(
    Layer.provideMerge(fakeCliLayer(options)),
    Layer.provideMerge(fakeGitProviderLayer(options)),
    Layer.provideMerge(fakeAgentProvidersLayer(options)),
    Layer.provide(
      AppConfig.layer({
        ...(options.appImagePath === undefined ? {} : { appImagePath: options.appImagePath }),
        databasePath: join(directory, "test.sqlite"),
        ...(options.diffDashCliPath === undefined
          ? {}
          : { diffDashCliPath: options.diffDashCliPath }),
        settingsPath: join(directory, "settings.json"),
        tempDir: directory,
      }),
    ),
  )

describe("Prerequisites", () => {
  it.scoped("detects Git, GitHub auth, coding agents, and diffdash in PATH", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const fakeBin = join(directory, "bin")
      const diffDashPath = join(fakeBin, "diffdash")
      yield* Effect.sync(() => {
        mkdirSync(fakeBin, { recursive: true })
        writeFileSync(diffDashPath, "#!/bin/sh\n", "utf8")
        chmodSync(diffDashPath, 0o755)
      })
      yield* withPath(fakeBin)

      const status = yield* Effect.gen(function* () {
        const prerequisites = yield* Prerequisites
        return yield* prerequisites.get
      }).pipe(
        Effect.provide(
          makeLayer(directory, {
            availableCommands: new Set(["git", "gh", "claude"]),
          }),
        ),
      )

      expect(status.gitInstalled).toBe(true)
      expect(status.ghInstalled).toBe(true)
      expect(status.ghVersion).toBeNull()
      expect(status.ghSearchRepositoriesAvailable).toBe(true)
      expect(status.ghSupported).toBe(true)
      expect(status.ghAuthenticated).toBe(true)
      expect(status.providerDiagnostics[0]?.descriptor.id).toBe("github")
      expect(status.setupRequirements[0]?.requiredForLocalUse).toBe(false)
      expect(status.codingAgentInstalled).toBe(true)
      expect(status.installedCodingAgents).toEqual(["claude"])
      expect(status.diffDashCliInstalled).toBe(true)
      expect(status.diffDashCliInPath).toBe(true)
      expect(status.diffDashCliPath).toBe(diffDashPath)
    }),
  )

  it.scoped("marks GitHub CLI versions below 2.7.0 as unsupported", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const status = yield* Effect.gen(function* () {
        const prerequisites = yield* Prerequisites
        return yield* prerequisites.get
      }).pipe(
        Effect.provide(
          makeLayer(directory, {
            availableCommands: new Set(["gh"]),
            ghVersion: "1.14.0",
          }),
        ),
      )

      expect(status.ghInstalled).toBe(false)
      expect(status.ghVersion).toBeNull()
      expect(status.ghSearchRepositoriesAvailable).toBe(true)
      expect(status.ghSupported).toBe(false)
    }),
  )

  it.scoped("requires the gh search repos capability even when auth succeeds", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const status = yield* Effect.gen(function* () {
        const prerequisites = yield* Prerequisites
        return yield* prerequisites.get
      }).pipe(
        Effect.provide(
          makeLayer(directory, {
            availableCommands: new Set(["gh"]),
            ghSearchRepositoriesAvailable: false,
          }),
        ),
      )

      expect(status.ghAuthenticated).toBe(true)
      expect(status.ghVersion).toBeNull()
      expect(status.ghSearchRepositoriesAvailable).toBe(true)
      expect(status.ghSupported).toBe(false)
    }),
  )

  it.scoped("installs the bundled diffdash CLI into the first writable PATH directory", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const fakeBin = join(directory, "bin")
      const sourcePath = join(directory, "source-diffdash")
      yield* Effect.sync(() => {
        writeFileSync(sourcePath, "#!/bin/sh\n", "utf8")
        chmodSync(sourcePath, 0o755)
      })
      yield* withPath(fakeBin)

      const result = yield* Effect.gen(function* () {
        const prerequisites = yield* Prerequisites
        return yield* prerequisites.installDiffDashCli
      }).pipe(
        Effect.provide(
          makeLayer(directory, {
            availableCommands: new Set(),
            diffDashCliPath: sourcePath,
          }),
        ),
      )

      expect(result.path).toBe(join(fakeBin, "diffdash"))
      expect(result.pathSetupCommand).toBeNull()
      expect(readlinkSync(result.path)).toBe(sourcePath)
    }),
  )

  it.scoped("falls back to a user-local bin directory when PATH has no writable directory", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const home = join(directory, "home")
      const sourcePath = join(directory, "source-diffdash")
      yield* Effect.sync(() => {
        mkdirSync(home, { recursive: true })
        writeFileSync(sourcePath, "#!/bin/sh\n", "utf8")
        chmodSync(sourcePath, 0o755)
      })
      yield* withPath("")
      yield* withHome(home)

      const { installedResult, diagnostics } = yield* Effect.gen(function* () {
        const prerequisites = yield* Prerequisites
        const createdInstallResult = yield* prerequisites.installDiffDashCli
        const currentDiagnostics = yield* prerequisites.get
        return { diagnostics: currentDiagnostics, installedResult: createdInstallResult }
      }).pipe(
        Effect.provide(
          makeLayer(directory, {
            availableCommands: new Set(),
            diffDashCliPath: sourcePath,
          }),
        ),
      )

      expect(installedResult.path).toBe(join(home, ".local", "bin", "diffdash"))
      expect(installedResult.pathSetupCommand).toBe(
        `export PATH='${join(home, ".local", "bin")}':$PATH`,
      )
      expect(readlinkSync(installedResult.path)).toBe(sourcePath)
      expect(diagnostics.diffDashCliInstalled).toBe(true)
      expect(diagnostics.diffDashCliInPath).toBe(false)
    }),
  )

  it.scoped("installs a durable AppImage launcher outside the temporary mount", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const home = join(directory, "home")
      const mountPath = join(directory, ".mount_DiffDash", "resources", "bin")
      const sourcePath = join(mountPath, "diffdash")
      const appImagePath = join(directory, "DiffDash user's build.AppImage")
      const capturePath = join(directory, "captured-args")
      yield* Effect.sync(() => {
        mkdirSync(mountPath, { recursive: true })
        mkdirSync(home, { recursive: true })
        copyFileSync(resolve("resources/linux/bin/diffdash"), sourcePath)
        chmodSync(sourcePath, 0o444)
        writeFileSync(
          appImagePath,
          '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$DIFFDASH_TEST_CAPTURE"\n',
          "utf8",
        )
        chmodSync(appImagePath, 0o755)
      })
      yield* withPath("")
      yield* withHome(home)

      const result = yield* Effect.gen(function* () {
        const prerequisites = yield* Prerequisites
        return yield* prerequisites.installDiffDashCli
      }).pipe(
        Effect.provide(
          makeLayer(directory, {
            appImagePath,
            availableCommands: new Set(),
            diffDashCliPath: sourcePath,
          }),
        ),
      )

      yield* Effect.sync(() => {
        rmSync(join(directory, ".mount_DiffDash"), { force: true, recursive: true })
        const launch = spawnSync("/bin/sh", [result.path, "install", "project with spaces"], {
          cwd: directory,
          encoding: "utf8",
          env: {
            ...process.env,
            DIFFDASH_TEST_CAPTURE: capturePath,
            PATH: "/usr/bin:/bin",
          },
        })
        expect(launch.status).toBe(0)
      })
      yield* Effect.promise(() => waitForFile(capturePath))

      expect(readFileSync(capturePath, "utf8").trim().split("\n")).toEqual([
        `--diffdash-cli-v1=${realpathSync(directory)}`,
        "--",
        "install",
        "project with spaces",
      ])
      const launcher = readFileSync(result.path, "utf8")
      expect(launcher).toContain("Generated by the DiffDash AppImage CLI installer")
      expect(launcher).not.toContain(sourcePath)
    }),
  )

  it.scoped("replaces a stale CLI symlink into an old AppImage mount", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const fakeBin = join(directory, "bin")
      const sourcePath = join(directory, "current-mount", "resources", "bin", "diffdash")
      const appImagePath = join(directory, "DiffDash.AppImage")
      const linkPath = join(fakeBin, "diffdash")
      yield* Effect.sync(() => {
        mkdirSync(fakeBin, { recursive: true })
        mkdirSync(join(directory, "current-mount", "resources", "bin"), { recursive: true })
        copyFileSync(resolve("resources/linux/bin/diffdash"), sourcePath)
        writeFileSync(appImagePath, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 })
        symlinkSync("/tmp/.mount_DiffDash/resources/bin/diffdash", linkPath)
      })
      yield* withPath(fakeBin)

      const result = yield* Effect.gen(function* () {
        const prerequisites = yield* Prerequisites
        return yield* prerequisites.installDiffDashCli
      }).pipe(
        Effect.provide(
          makeLayer(directory, {
            appImagePath,
            availableCommands: new Set(),
            diffDashCliPath: sourcePath,
          }),
        ),
      )

      expect(result.path).toBe(linkPath)
      expect(readFileSync(linkPath, "utf8")).toContain(
        "Generated by the DiffDash AppImage CLI installer",
      )
    }),
  )

  it.scoped("refreshes a marker-owned AppImage launcher after an app update", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const fakeBin = join(directory, "bin")
      const sourcePath = join(directory, "resources", "bin", "diffdash")
      const appImagePath = join(directory, "DiffDash.AppImage")
      const launcherPath = join(fakeBin, "diffdash")
      yield* Effect.sync(() => {
        mkdirSync(fakeBin, { recursive: true })
        mkdirSync(join(directory, "resources", "bin"), { recursive: true })
        copyFileSync(resolve("resources/linux/bin/diffdash"), sourcePath)
        writeFileSync(appImagePath, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 })
        writeFileSync(
          launcherPath,
          "#!/bin/sh\n# Generated by the DiffDash AppImage CLI installer.\nold parser\n",
          { encoding: "utf8", mode: 0o755 },
        )
      })
      yield* withPath(fakeBin)

      yield* Effect.sync(() => refreshAppImageCliLaunchers(sourcePath, appImagePath))

      const launcher = readFileSync(launcherPath, "utf8")
      expect(launcher).toContain("--diffdash-cli-v1")
      expect(launcher).not.toContain("old parser")
    }),
  )

  it.scoped("resolves an executable in a supplied PATH", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      const executablePath = join(directory, "diffdash")
      yield* Effect.sync(() => {
        writeFileSync(executablePath, "#!/bin/sh\n", "utf8")
        chmodSync(executablePath, 0o755)
      })

      expect(resolveExecutableInPath("diffdash", { envPath: directory })).toBe(executablePath)
    }),
  )
})

const fakeGitProviderLayer = (options: {
  readonly availableCommands: ReadonlySet<string>
  readonly ghAuthenticated?: boolean
  readonly ghSearchRepositoriesAvailable?: boolean
  readonly ghVersion?: string
}) => {
  const providerId = GitProviderId.make("github")
  const descriptor = GitProviderDescriptor.make({
    id: providerId,
    kind: GitProviderKind.make("github"),
    displayName: "GitHub",
    host: "github.com",
    capabilities: GitProviderCapabilities.make({
      repositorySearch: true,
      searchScopes: true,
      assignedReviews: true,
      reviewDecisions: true,
      fileUrls: true,
      remoteWorkspaceBootstrap: true,
    }),
    terminology: GitProviderTerminology.make({
      repositorySingular: "repository",
      repositoryPlural: "repositories",
      reviewSingular: "pull request",
      reviewPlural: "pull requests",
    }),
  })
  const supported =
    options.availableCommands.has("gh") &&
    (options.ghSearchRepositoriesAvailable ?? true) &&
    Number(options.ghVersion?.split(".")[0] ?? "2") >= 2
  const diagnostic = GitProviderDiagnostic.make({
    providerId,
    available: supported,
    authenticated: options.ghAuthenticated ?? true,
    message: supported ? null : "GitHub CLI is unavailable or unsupported.",
  })
  return Layer.succeed(
    GitProvider,
    GitProvider.of({
      listProviders: Effect.succeed([descriptor]),
      diagnoseProviders: Effect.succeed([diagnostic]),
      parseRemoteUrl: () => unavailableProviderMethod(),
      repositoryUrl: () => unavailableProviderMethod(),
      fileUrl: () => unavailableProviderMethod(),
      searchRepositories: () => unavailableProviderMethod(),
      listSearchScopes: () => unavailableProviderMethod(),
      listPullRequests: () => unavailableProviderMethod(),
      listReviewRequests: () => unavailableProviderMethod(),
      getPullRequestDetail: () => unavailableProviderMethod(),
      refreshPullRequestDetail: () => unavailableProviderMethod(),
      getPullRequestDiff: () => unavailableProviderMethod(),
      hasApprovedPullRequest: () => unavailableProviderMethod(),
      approvePullRequest: () => unavailableProviderMethod(),
      hostedReviewCheckoutSpec: () => unavailableProviderMethod(),
      bootstrapBareRepository: () => unavailableProviderMethod(),
      isAvailable: () => Effect.succeed(supported),
    }),
  )
}

const fakeAgentProvidersLayer = (options: { readonly availableCommands: ReadonlySet<string> }) =>
  Layer.succeed(
    AgentProviders,
    AgentProviders.of({
      catalog: Effect.succeed(
        AgentProviderCatalog.make({
          providers: ["claude", "codex", "opencode"].map((id) => {
            const ready = options.availableCommands.has(id)
            return AgentProviderStatus.make({
              id,
              displayName: id,
              description: `${id} fixture`,
              homepage: null,
              capabilities: [
                AgentProviderCapabilityStatus.make({
                  capability: "walkthrough",
                  status: ready ? "ready" : "unavailable",
                  runtimeVersion: ready ? "1.0.0" : null,
                  reason: ready ? null : `${id} is unavailable`,
                }),
              ],
              models: [],
              defaults: AgentProviderDefaults.make({
                walkthroughModel: null,
                reviewThreadModel: null,
              }),
              setup: [],
            })
          }),
          autoCandidates: AgentProviderAutoCandidates.make({
            walkthrough: ["claude", "codex", "opencode"],
            reviewThread: ["claude", "codex", "opencode"],
          }),
        }),
      ),
    }),
  )

const fakeCliLayer = (options: {
  readonly availableCommands: ReadonlySet<string>
  readonly ghAuthenticated?: boolean
  readonly ghSearchRepositoriesAvailable?: boolean
  readonly ghVersion?: string
}) =>
  Layer.succeed(
    CliService,
    CliService.of({
      run: (command, args) => {
        if (command === "gh" && args[0] === "auth") {
          return options.availableCommands.has("gh") && (options.ghAuthenticated ?? true)
            ? Effect.succeed(cliResult(command, args))
            : Effect.fail(cliError(command, args))
        }

        if (command === "gh" && args[0] === "--version") {
          return options.availableCommands.has("gh")
            ? Effect.succeed(
                cliResult(command, args, `gh version ${options.ghVersion ?? "2.76.1"}`),
              )
            : Effect.fail(cliError(command, args))
        }

        if (command === "gh" && args[0] === "search") {
          return options.availableCommands.has("gh") &&
            (options.ghSearchRepositoriesAvailable ?? true)
            ? Effect.succeed(cliResult(command, args))
            : Effect.fail(cliError(command, args))
        }

        return options.availableCommands.has(command)
          ? Effect.succeed(cliResult(command, args))
          : Effect.fail(cliError(command, args))
      },
    }),
  )

const cliResult = (
  command: string,
  args: readonly string[],
  stdout = `${command} ok`,
): CliResult => ({
  args,
  command,
  cwd: null,
  exitCode: 0,
  stderr: "",
  stdout,
})

const cliError = (command: string, args: readonly string[]) =>
  CliError.make({
    args: [...args],
    cause: null,
    command,
    cwd: null,
    exitCode: 1,
    stderr: `${command} missing`,
    stdout: "",
  })
