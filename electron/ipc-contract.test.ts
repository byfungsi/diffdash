import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const EXPECTED_INVOKE_CHANNELS = [
  "analytics:capture",
  "analytics:start",
  "app:diagnostics",
  "app:installDiffDashCli",
  "app:openExternalUrl",
  "app:openLocalRepositoryFile",
  "app:openRepositoryFile",
  "appState:get",
  "appState:update",
  "gitProvider:approvePullRequest",
  "gitProvider:getPullRequestDetail",
  "gitProvider:getPullRequestDiff",
  "gitProvider:hasApprovedPullRequest",
  "gitProvider:listPullRequests",
  "gitProvider:listReviewRequests",
  "gitProvider:listSearchScopes",
  "gitProvider:refreshPullRequestDetail",
  "gitProvider:searchRepositories",
  "localReviews:getDetail",
  "localReviews:getDiff",
  "localReviews:getSnapshot",
  "localReviews:resolveBranch",
  "localWalkthroughs:generate",
  "localWalkthroughs:get",
  "navigation:drainCommands",
  "repositories:addLocal",
  "repositories:favoriteRemote",
  "repositories:install",
  "repositories:link",
  "repositories:list",
  "repositories:selectLocalFolder",
  "repositories:setFavorite",
  "reviewThreads:addUserMessage",
  "reviewThreads:create",
  "reviewThreads:get",
  "reviewThreads:list",
  "reviewThreads:runAgent",
  "settings:get",
  "settings:update",
  "updates:check",
  "updates:download",
  "updates:getState",
  "updates:restartAndInstall",
  "viewedFiles:list",
  "viewedFiles:listLocal",
  "viewedFiles:set",
  "viewedFiles:setLocal",
  "walkthroughs:generate",
  "walkthroughs:get",
] as const

const EXPECTED_EVENT_CHANNELS = [
  "navigation:commandsAvailable",
  "reviewThreads:agentProgress",
  "updates:stateChanged",
] as const

describe("IPC contract", () => {
  const preload = parseSource("electron/preload/index.ts")
  const main = parseSource("electron/main/index.ts")

  it("keeps every preload invocation paired with exactly one main handler", () => {
    const invokeChannels = collectCallChannels(preload, "invoke")
    const handleChannels = collectCallChannels(main, "handle", "ipcMain")

    expect(new Set(invokeChannels)).toEqual(new Set(EXPECTED_INVOKE_CHANNELS))
    expect(new Set(handleChannels)).toEqual(new Set(EXPECTED_INVOKE_CHANNELS))
    expect(duplicates(handleChannels)).toEqual([])
  })

  it("keeps renderer subscriptions paired with cleanup and main emissions", () => {
    const subscribedChannels = collectCallChannels(preload, "on", "ipcRenderer")
    const removedChannels = collectCallChannels(preload, "removeListener", "ipcRenderer")
    const emittedChannels = collectCallChannels(main, "send")

    expect(new Set(subscribedChannels)).toEqual(new Set(EXPECTED_EVENT_CHANNELS))
    expect(new Set(removedChannels)).toEqual(new Set(EXPECTED_EVENT_CHANNELS))
    expect(duplicates(subscribedChannels)).toEqual([])
    expect(duplicates(removedChannels)).toEqual([])
    for (const channel of EXPECTED_EVENT_CHANNELS) {
      expect(emittedChannels).toContain(channel)
    }
  })
})

const parseSource = (path: string) => {
  const absolutePath = resolve(path)
  return ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}

const collectCallChannels = (source: ts.SourceFile, method: string, owner?: string) => {
  const channels: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const isPropertyCall = ts.isPropertyAccessExpression(node.expression)
      const callOwner = isPropertyCall ? node.expression.expression.getText(source) : undefined
      const callMethod = isPropertyCall
        ? node.expression.name.text
        : ts.isIdentifier(node.expression)
          ? node.expression.text
          : null
      const channel = node.arguments[0]
      if (
        callMethod === method &&
        (owner === undefined || callOwner === owner) &&
        channel !== undefined &&
        ts.isStringLiteral(channel)
      ) {
        channels.push(channel.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return channels
}

const duplicates = (values: readonly string[]) => [
  ...new Set(values.filter((value, index) => values.indexOf(value) !== index)),
]
