import { _electron as electron, expect, test, type Page } from "@playwright/test"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

test("covers finished Home to Review flow with fake CLI fixtures", async ({
  browserName: _browserName,
}, testInfo) => {
  const fakeBin = testInfo.outputPath("fake-bin")
  const xdgConfigHome = testInfo.outputPath("xdg-config")
  const userData = testInfo.outputPath("user-data")
  await mkdir(fakeBin, { recursive: true })
  await mkdir(xdgConfigHome, { recursive: true })
  await mkdir(userData, { recursive: true })
  await installFakeCli(fakeBin)

  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js"), `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: xdgConfigHome,
    },
  })

  try {
    const window = await app.firstWindow()
    await dismissOnboardingIfPresent(window)
    await expect(window.getByRole("heading", { name: "DiffDash" })).toBeVisible()
    await expect(window.getByText("Recent Review Requests")).toBeVisible()
    await expect(window.getByText("Request review flow")).toBeVisible()

    await window.getByRole("button", { name: /Open requested review #51/ }).click()

    await expect(window.getByRole("heading", { name: "Request review flow" })).toBeVisible()
    await expect(window.getByText("src/app.tsx").first()).toBeVisible()
    await expect(window.getByText("Viewed").first()).toBeVisible()
    await expect(window.getByText("+1").first()).toBeVisible()
    await expect(window.getByText("-1").first()).toBeVisible()
    await expect(window.getByRole("button", { name: "Request changes" })).toBeHidden()

    await window.getByRole("button", { name: "Approve" }).click()
    await expect(window.getByRole("button", { name: "Approved" })).toBeVisible()

    await window.getByRole("button", { name: "Walkthrough" }).click()

    await expect(window.getByText("Review focus")).toBeVisible()
    await expect(window.getByRole("heading", { name: "Entry point" })).toBeVisible()
    await expect(window.getByText("CRITICAL")).toBeVisible()
  } finally {
    await app.close()
  }
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

  const app = await electron.launch({
    args: [
      join(process.cwd(), "out/main/index.js"),
      `--user-data-dir=${userData}`,
      `--diffdash-local-path=${localRepo}`,
    ],
    env: {
      ...process.env,
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

const installFakeCli = async (directory: string) => {
  await Promise.all([
    writeExecutable(join(directory, "diffdash"), fakeDiffDashScript),
    writeExecutable(join(directory, "gh"), fakeGhScript),
    writeExecutable(join(directory, "git"), fakeGitScript),
    writeExecutable(join(directory, "codex"), fakeCodexScript),
  ])
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

const fakeDiffDashScript = `#!/usr/bin/env node
process.exit(0)
`

const fakeGitScript = `#!/usr/bin/env node
const args = process.argv.slice(2)
const joined = args.join(" ")
const repoRoot = process.env.FAKE_REPO_ROOT ?? "/tmp/diffdash-local-repo"

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

if (joined.includes("rev-parse --verify HEAD")) {
  console.log("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
  process.exit(0)
}

if (joined.includes("diff --no-ext-diff HEAD --")) {
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

if (args[0] === "exec") {
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

console.error("Unhandled fake codex call: " + args.join(" "))
process.exit(1)
`

const fakeGhScript = `#!/usr/bin/env node
const args = process.argv.slice(2)
const joined = args.join(" ")

const pullRequest = {
  author: { login: "octocat" },
  baseRefName: "main",
  baseRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  body: "Please review this workspace change.",
  createdAt: "2026-07-07T00:00:00Z",
  headRefName: "feature/requested-review",
  headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  isDraft: false,
  number: 51,
  state: "OPEN",
  title: "Request review flow",
  updatedAt: "2026-07-07T02:00:00Z",
  url: "https://github.com/fungsi/diffdash/pull/51"
}

if (args[0] === "--version") {
  console.log("gh version 2.0.0")
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
