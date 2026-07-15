import { execFileSync } from "node:child_process"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { _electron as electron, expect, type Page, test } from "@playwright/test"

test("covers finished Home to Review flow with fake CLI fixtures", async ({
  browserName: _browserName,
}, testInfo) => {
  const fakeBin = testInfo.outputPath("fake-bin")
  const linkedRepo = testInfo.outputPath("linked-repo")
  const poolPath = testInfo.outputPath("worktree-pool")
  const xdgConfigHome = testInfo.outputPath("xdg-config")
  const userData = testInfo.outputPath("user-data")
  await mkdir(fakeBin, { recursive: true })
  await mkdir(xdgConfigHome, { recursive: true })
  await mkdir(userData, { recursive: true })
  await installFakeCli(fakeBin)
  await installCodexSettings(xdgConfigHome)
  const pullRequest = await installPullRequestRepository(
    linkedRepo,
    testInfo.outputPath("origin.git"),
  )
  const sourceBranch = realGit(linkedRepo, "branch", "--show-current")
  const sourceStatus = realGit(linkedRepo, "status", "--porcelain", "--untracked-files=all")

  const app = await electron.launch({
    args: [
      join(process.cwd(), "out/main/index.js"),
      `--user-data-dir=${userData}`,
      `--diffdash-link-path=${linkedRepo}`,
    ],
    env: {
      ...process.env,
      DIFFDASH_ALLOW_MULTIPLE_INSTANCES: "1",
      DIFFDASH_WORKTREE_POOL_PATH: poolPath,
      FAKE_PR_BASE_SHA: pullRequest.baseSha,
      FAKE_PR_HEAD_SHA: pullRequest.headSha,
      FAKE_USE_REAL_GIT: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${pullRequest.remote}.insteadOf`,
      GIT_CONFIG_VALUE_0: "git@github.com:fungsi/diffdash.git",
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      REAL_GIT_PATH: "/usr/bin/git",
      XDG_CONFIG_HOME: xdgConfigHome,
    },
  })

  try {
    const window = await app.firstWindow()
    await dismissOnboardingIfPresent(window)
    await expect(window.locator("html")).toHaveClass(/dark/)
    await expect(
      window.getByRole("button", { name: /Use (?:light|dark|system) theme/ }),
    ).toHaveCount(0)
    await expect(window.getByRole("button", { name: "Home" })).toBeVisible()
    const openPullRequest = window.getByRole("button", { name: /Open (?:requested review|PR) #51/ })
    await expect(openPullRequest).toBeVisible()
    await openPullRequest.click()

    await expect(window.getByRole("heading", { name: "Request review flow" })).toBeVisible()
    await expect(window.getByText("Link a checkout for isolated agent review")).toHaveCount(0)
    await expect(window.getByText("src/app.tsx").first()).toBeVisible()
    await expect(window.getByText("Viewed").first()).toBeVisible()
    await expect(window.getByText("+1").first()).toBeVisible()
    await expect(window.getByText("-1").first()).toBeVisible()
    await expect(window.getByRole("button", { name: "Request changes" })).toBeHidden()

    const addedLine = window
      .locator("diffs-container [data-line]")
      .filter({ hasText: "new" })
      .first()
    const gutterNumber = window
      .locator("diffs-container [data-column-number]")
      .filter({ hasText: "1" })
      .first()
    await expect(addedLine).toBeVisible()
    await gutterNumber.dispatchEvent("pointermove", {
      bubbles: true,
      composed: true,
      pointerType: "mouse",
    })
    const gutterUtility = window.locator("diffs-container [data-utility-button]")
    await expect(gutterUtility).toBeVisible()
    const utilityPointerEvent = {
      bubbles: true,
      button: 0,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
    }
    await gutterUtility.dispatchEvent("pointerdown", utilityPointerEvent)
    await gutterUtility.dispatchEvent("pointerup", utilityPointerEvent)
    const initialComposer = window.getByRole("textbox", { name: "Thread message" })
    await expect(initialComposer).toBeVisible()
    await initialComposer.fill("Why was this line changed?")
    await window.getByRole("button", { name: "Comment" }).click()

    await expect(window.getByText("Why was this line changed?")).toBeVisible()
    await expect(window.getByText("Agent is reviewing...")).toBeVisible()
    await expect(window.getByText("The line check is complete.")).toBeVisible()
    const reviewDisclosure = window.getByRole("button", { name: "Review on L1" })
    const reviewContainer = window.locator("[data-review-thread-annotation]")
    await expect(reviewDisclosure).toHaveAttribute("aria-expanded", "true")
    await expect(reviewContainer).not.toContainText("src/app.tsx:1")
    await expect(reviewContainer).not.toContainText("Current revision")
    await reviewDisclosure.click()
    await expect(reviewDisclosure).toHaveAttribute("aria-expanded", "false")
    await expect(window.getByText("Why was this line changed?")).toBeHidden()
    await expect(reviewDisclosure).toBeVisible()
    await reviewDisclosure.click()
    await expect(reviewDisclosure).toHaveAttribute("aria-expanded", "true")
    const followUpComposer = window.getByRole("textbox", { name: "Thread message" })
    await expect(followUpComposer).toBeVisible()
    await followUpComposer.fill("What behavior does it preserve?")
    await window.getByRole("button", { name: "Send" }).click()

    await expect(window.getByText("What behavior does it preserve?")).toBeVisible()
    await expect(window.getByText("Agent is reviewing...")).toBeVisible()
    await expect(window.getByText("The line check is complete.")).toHaveCount(2)
    await expect(window.getByRole("button", { name: "Close" })).toBeHidden()
    await expect(window.getByRole("heading", { name: "Request review flow" })).toBeVisible()

    await window.getByRole("button", { name: "Actions" }).click()
    await window.getByRole("menuitem", { name: /Approve/ }).click()
    await window.getByRole("button", { name: "Actions" }).click()
    await expect(window.getByRole("menuitem", { name: /Approved/ })).toBeVisible()

    await window.getByRole("button", { name: "Walkthrough" }).click()

    await expect(window.getByText("Review focus")).toBeVisible()
    await expect(window.getByRole("heading", { name: "Entry point" })).toBeVisible()
    await expect(window.getByText("CRITICAL")).toBeVisible()
  } finally {
    await app.close()
  }
  expect(realGit(linkedRepo, "branch", "--show-current")).toBe(sourceBranch)
  expect(realGit(linkedRepo, "status", "--porcelain", "--untracked-files=all")).toBe(sourceStatus)
})

test("opens local working tree review from CLI argument", async ({
  browserName: _browserName,
}, testInfo) => {
  const fakeBin = testInfo.outputPath("fake-bin")
  const localRepo = testInfo.outputPath("local-repo")
  const xdgConfigHome = testInfo.outputPath("xdg-config")
  const userData = testInfo.outputPath("user-data")
  await mkdir(fakeBin, { recursive: true })
  await mkdir(localRepo, { recursive: true })
  await mkdir(xdgConfigHome, { recursive: true })
  await mkdir(userData, { recursive: true })
  await installFakeCli(fakeBin)
  await installCodexSettings(xdgConfigHome)

  const app = await electron.launch({
    args: [
      join(process.cwd(), "out/main/index.js"),
      `--user-data-dir=${userData}`,
      `--diffdash-local-path=${localRepo}`,
    ],
    env: {
      ...process.env,
      DIFFDASH_ALLOW_MULTIPLE_INSTANCES: "1",
      FAKE_REPO_ROOT: localRepo,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: xdgConfigHome,
    },
  })

  try {
    const window = await app.firstWindow()
    await dismissOnboardingIfPresent(window)
    await expect(window.getByRole("heading", { name: "Local changes" })).toBeVisible()
    await expect(window.getByText("src/local.ts").first()).toBeVisible()
    await expect(window.getByText("notes.txt").first()).toBeVisible()
    await expect(window.getByRole("button", { name: "Approve" })).toBeHidden()

    await window.getByRole("button", { name: "Walkthrough" }).click()
    await expect(window.getByText("Review focus")).toBeVisible()
    await expect(window.getByRole("heading", { name: "Entry point" })).toBeVisible()
  } finally {
    await app.close()
  }
})

test("opens a merge-base branch comparison from the versioned CLI command", async ({
  browserName: _browserName,
}, testInfo) => {
  const fakeBin = testInfo.outputPath("fake-bin")
  const localRepo = testInfo.outputPath("local-repo")
  const xdgConfigHome = testInfo.outputPath("xdg-config")
  const userData = testInfo.outputPath("user-data")
  await mkdir(fakeBin, { recursive: true })
  await mkdir(localRepo, { recursive: true })
  await mkdir(xdgConfigHome, { recursive: true })
  await mkdir(userData, { recursive: true })
  await installFakeCli(fakeBin)
  await installCodexSettings(xdgConfigHome)

  const app = await electron.launch({
    args: [
      join(process.cwd(), "out/main/index.js"),
      `--user-data-dir=${userData}`,
      "--diffdash-cli-v1",
      localRepo,
      "--",
      "diff",
      "dev",
    ],
    env: {
      ...process.env,
      DIFFDASH_ALLOW_MULTIPLE_INSTANCES: "1",
      FAKE_REPO_ROOT: localRepo,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: xdgConfigHome,
    },
  })

  try {
    const window = await app.firstWindow()
    await dismissOnboardingIfPresent(window)
    await expect(window.getByRole("heading", { name: "Changes vs dev" })).toBeVisible()
    await expect(window.getByText("vs dev", { exact: true })).toBeVisible()
    await expect(window.getByText("src/local.ts").first()).toBeVisible()
  } finally {
    await app.close()
  }
})

test("forwards a CLI command to the running DiffDash instance", async ({
  browserName: _browserName,
}, testInfo) => {
  const fakeBin = testInfo.outputPath("fake-bin")
  const localRepo = testInfo.outputPath("local-repo")
  const xdgConfigHome = testInfo.outputPath("xdg-config")
  const userData = testInfo.outputPath("user-data")
  await mkdir(fakeBin, { recursive: true })
  await mkdir(localRepo, { recursive: true })
  await mkdir(xdgConfigHome, { recursive: true })
  await mkdir(userData, { recursive: true })
  await installFakeCli(fakeBin)
  await installCodexSettings(xdgConfigHome)

  const appEnvironment = {
    ...process.env,
    FAKE_REPO_ROOT: localRepo,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: xdgConfigHome,
  }
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js"), `--user-data-dir=${userData}`],
    env: appEnvironment,
  })

  try {
    const window = await app.firstWindow()
    await dismissOnboardingIfPresent(window)
    await expect(window.getByRole("heading", { name: "DiffDash" })).toBeVisible()

    const electronExecutable = execFileSync(process.execPath, ["-p", "require('electron')"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim()
    execFileSync(
      electronExecutable,
      [
        join(process.cwd(), "out/main/index.js"),
        `--user-data-dir=${userData}`,
        `--diffdash-cli-v1=${localRepo}`,
        "--",
        "diff",
        "dev",
      ],
      { env: appEnvironment, stdio: "ignore", timeout: 10_000 },
    )

    await expect(window.getByRole("heading", { name: "Changes vs dev" })).toBeVisible()
    await expect(window.getByText("src/local.ts").first()).toBeVisible()
  } finally {
    await app.close()
  }
})

test("shows a reloadable Electron fallback when the renderer cannot load", async ({
  browserName: _browserName,
}, testInfo) => {
  const userData = testInfo.outputPath("user-data")
  await mkdir(userData, { recursive: true })
  const unavailableRendererUrl = "http://127.0.0.1:1"
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js"), `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      DIFFDASH_ALLOW_MULTIPLE_INSTANCES: "1",
      ELECTRON_RENDERER_URL: unavailableRendererUrl,
    },
  })

  try {
    const window = await app.firstWindow()
    await expect(
      window.getByRole("heading", { name: "DiffDash encountered an error" }),
    ).toBeVisible()
    await expect(window.getByRole("alert")).toContainText("Renderer failed to load")
    await expect(window.getByRole("link", { name: "Reload DiffDash" })).toHaveAttribute(
      "href",
      unavailableRendererUrl,
    )
  } finally {
    await app.close()
  }
})

const installFakeCli = async (directory: string) => {
  await Promise.all([
    writeExecutable(join(directory, "diffdash"), fakeDiffDashScript),
    writeExecutable(join(directory, "gh"), fakeGhScript),
    writeExecutable(join(directory, "git"), fakeGitScript),
    writeExecutable(join(directory, "codex"), fakeCodexScript),
    writeExecutable(join(directory, "claude"), fakeClaudeScript),
  ])
}

const installCodexSettings = async (xdgConfigHome: string) => {
  const settingsDirectory = join(xdgConfigHome, "diffdash")
  await mkdir(settingsDirectory, { recursive: true })
  await writeFile(
    join(settingsDirectory, "settings.json"),
    JSON.stringify({
      appearance: "dark",
      provider: "codex",
      models: {
        auto: "balance",
        claude: "claude-sonnet-5",
        codex: "gpt-5.3-codex-spark",
        opencode: "openai/gpt-5.3-codex-spark",
      },
    }),
    "utf8",
  )
}

const dismissOnboardingIfPresent = async (window: Page) => {
  const continueButton = window.getByRole("button", { name: "Continue to DiffDash" })
  try {
    await continueButton.waitFor({ state: "visible", timeout: 2_000 })
    await continueButton.click()
  } catch {
    // Onboarding is only shown for fresh app state.
  }
}

const writeExecutable = async (path: string, content: string) => {
  await writeFile(path, content, "utf8")
  await chmod(path, 0o755)
}

const installPullRequestRepository = async (source: string, remote: string) => {
  await mkdir(source, { recursive: true })
  realGit(source, "init")
  await writeFile(join(source, "src-app.tsx"), "old\n")
  realGit(source, "add", ".")
  commit(source, "base")
  const baseSha = realGit(source, "rev-parse", "HEAD")
  realGit(process.cwd(), "clone", "--bare", source, remote)
  realGit(source, "remote", "add", "origin", "git@github.com:fungsi/diffdash.git")
  await writeFile(join(source, "src-app.tsx"), "new\n")
  realGit(source, "add", ".")
  commit(source, "feature")
  const headSha = realGit(source, "rev-parse", "HEAD")
  realGit(source, "push", remote, "HEAD:refs/pull/51/head")
  realGit(source, "reset", "--hard", baseSha)
  await writeFile(join(source, "user-local.txt"), "preserve\n")
  return { baseSha, headSha, remote }
}

const commit = (cwd: string, message: string) =>
  realGit(
    cwd,
    "-c",
    "user.name=DiffDash Test",
    "-c",
    "user.email=test@diffdash.dev",
    "commit",
    "-m",
    message,
  )

const realGit = (cwd: string, ...args: readonly string[]) =>
  execFileSync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

const fakeDiffDashScript = `#!/usr/bin/env node
process.exit(0)
`

const fakeGitScript = `#!/usr/bin/env node
import { spawnSync } from "node:child_process"
const args = process.argv.slice(2)
const joined = args.join(" ")
const repoRoot = process.env.FAKE_REPO_ROOT ?? "/tmp/diffdash-local-repo"

if (process.env.FAKE_USE_REAL_GIT === "1") {
  if (joined.includes("remote get-url origin")) {
    console.log("git@github.com:fungsi/diffdash.git")
    process.exit(0)
  }
  const result = spawnSync(process.env.REAL_GIT_PATH ?? "/usr/bin/git", args, {
    env: process.env,
    stdio: "inherit"
  })
  process.exit(result.status ?? 1)
}

if (args[0] === "--version") {
  console.log("git version 2.50.0")
  process.exit(0)
}

if (joined.includes("rev-parse --show-toplevel")) {
  console.log(repoRoot)
  process.exit(0)
}

if (joined.includes("branch --show-current")) {
  console.log("feature/local-review")
  process.exit(0)
}

if (joined.includes("check-ref-format --branch dev")) {
  console.log("dev")
  process.exit(0)
}

if (joined.includes("fetch --no-tags origin +refs/heads/dev:refs/remotes/origin/dev")) {
  process.exit(0)
}

if (joined.includes("rev-parse --verify --end-of-options refs/remotes/origin/dev^{commit}")) {
  console.log("dddddddddddddddddddddddddddddddddddddddd")
  process.exit(0)
}

if (joined.includes("merge-base dddddddddddddddddddddddddddddddddddddddd HEAD")) {
  console.log("cccccccccccccccccccccccccccccccccccccccc")
  process.exit(0)
}

if (joined.includes("rev-parse --verify HEAD")) {
  console.log("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
  process.exit(0)
}

if (joined.includes("diff --no-ext-diff bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --")) {
  console.log([
    "diff --git a/src/local.ts b/src/local.ts",
    "index 1111111..2222222 100644",
    "--- a/src/local.ts",
    "+++ b/src/local.ts",
    "@@ -1,1 +1,1 @@",
    "-old local",
    "+new local"
  ].join("\\n"))
  process.exit(0)
}

if (joined.includes("diff --no-ext-diff cccccccccccccccccccccccccccccccccccccccc --")) {
  console.log([
    "diff --git a/src/local.ts b/src/local.ts",
    "index 1111111..2222222 100644",
    "--- a/src/local.ts",
    "+++ b/src/local.ts",
    "@@ -1,1 +1,1 @@",
    "-dev version",
    "+feature worktree"
  ].join("\\n"))
  process.exit(0)
}

if (joined.includes("ls-files --others --exclude-standard -z")) {
  process.stdout.write("notes.txt\\0")
  process.exit(0)
}

if (args[0] === "diff" && args.includes("--no-index")) {
  console.log([
    "diff --git a/notes.txt b/notes.txt",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/notes.txt",
    "@@ -0,0 +1 @@",
    "+local note"
  ].join("\\n"))
  process.exit(1)
}

console.error("Unhandled fake git call: " + joined)
process.exit(1)
`

const fakeCodexScript = `#!/usr/bin/env node
const args = process.argv.slice(2)

if (args[0] === "--version") {
  console.log("codex 0.1.0")
  process.exit(0)
}

if (!args.includes("exec")) {
  console.error("Unhandled fake codex call: " + args.join(" "))
  process.exit(1)
} else if (args.includes("--output-schema")) {
    setTimeout(() => {
      console.log([
        JSON.stringify({ type: "thread.started", thread_id: "codex-e2e-thread" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "message-1",
            type: "agent_message",
            text: JSON.stringify({
              bodyMarkdown: "The line check is complete.",
              threadSummaryUpdate: null,
              referencedAnchors: null
            })
          }
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 }
        })
      ].join("\\n"))
      process.exit(0)
    }, 500)
} else {
  console.log(JSON.stringify({
    title: "Review path",
    summary: "Review the app entry point first.",
    chapters: [{
      id: "c1",
      title: "Runtime",
      summary: "Runtime behavior changes.",
      stops: [{
        id: "s1",
        title: "Entry point",
        summary: "The changed app file owns the visible review behavior.",
        risk: "critical",
        hunkIds: ["h1"]
      }]
    }]
  }))
  process.exit(0)
}
`

const fakeClaudeScript = `#!/usr/bin/env node
const args = process.argv.slice(2)

if (args[0] === "--version") {
  console.log("claude 0.1.0")
  process.exit(0)
}

if (args[0] === "--print") {
  console.log(JSON.stringify({
    title: "Review path",
    summary: "Review the app entry point first.",
    chapters: [{
      id: "c1",
      title: "Runtime",
      summary: "Runtime behavior changes.",
      stops: [{
        id: "s1",
        title: "Entry point",
        summary: "The changed app file owns the visible review behavior.",
        risk: "critical",
        hunkIds: ["h1"]
      }]
    }]
  }))
  process.exit(0)
}

console.error("Unhandled fake claude call: " + args.join(" "))
process.exit(1)
`

const fakeGhScript = `#!/usr/bin/env node
const args = process.argv.slice(2)
const joined = args.join(" ")

const pullRequest = {
  author: { login: "octocat" },
  baseRefName: "main",
  baseRefOid: process.env.FAKE_PR_BASE_SHA ?? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  body: "Please review this workspace change.",
  createdAt: "2026-07-07T00:00:00Z",
  headRefName: "feature/requested-review",
  headRefOid: process.env.FAKE_PR_HEAD_SHA ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  isDraft: false,
  number: 51,
  state: "OPEN",
  title: "Request review flow",
  updatedAt: "2026-07-07T02:00:00Z",
  url: "https://github.com/fungsi/diffdash/pull/51"
}

if (args[0] === "--version") {
  console.log("gh version 2.76.1")
  process.exit(0)
}

if (args[0] === "search" && args[1] === "repos" && args[2] === "--help") {
  console.log("Search for repositories on GitHub.")
  process.exit(0)
}

if (args[0] === "search" && args[1] === "repos") {
  console.log("[]")
  process.exit(0)
}

if (args[0] === "auth" && args[1] === "status") {
  console.log("Logged in to github.com")
  process.exit(0)
}

if (args[0] === "api" && args[1] === "graphql") {
  if (joined.includes("review-requested:@me")) {
    console.log(JSON.stringify({
      data: {
        search: {
          nodes: [{
            ...pullRequest,
            repository: { name: "diffdash", owner: { login: "fungsi" } }
          }]
        }
      }
    }))
    process.exit(0)
  }

  if (joined.includes("latestReviews")) {
    console.log(JSON.stringify({
      data: {
        viewer: { login: "hanipcode" },
        repository: {
          pullRequest: {
            latestReviews: { nodes: [] }
          }
        }
      }
    }))
    process.exit(0)
  }

  console.log(JSON.stringify({ data: { viewer: { repositories: { nodes: [] } } } }))
  process.exit(0)
}

if (args[0] === "pr" && args[1] === "review" && args.includes("--approve")) {
  process.exit(0)
}

if (args[0] === "pr" && args[1] === "list") {
  console.log(JSON.stringify([pullRequest]))
  process.exit(0)
}

if (args[0] === "pr" && args[1] === "view") {
  const jsonFields = args[args.indexOf("--json") + 1] ?? ""
  if (jsonFields === "headRefOid") {
    console.log(JSON.stringify({ headRefOid: pullRequest.headRefOid }))
    process.exit(0)
  }

  console.log(JSON.stringify({
    ...pullRequest,
    commits: [],
    files: [{
      additions: 1,
      changeType: "modified",
      deletions: 1,
      path: "src/app.tsx"
    }]
  }))
  process.exit(0)
}

if (args[0] === "pr" && args[1] === "diff") {
  console.log([
    "diff --git a/src/app.tsx b/src/app.tsx",
    "index 1111111..2222222 100644",
    "--- a/src/app.tsx",
    "+++ b/src/app.tsx",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new"
  ].join("\\n"))
  process.exit(0)
}

console.error("Unhandled fake gh call: " + joined)
process.exit(1)
`
