import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { EventChannel, InvokeChannel } from "@diffdash/protocol/channels"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const EXPECTED_INVOKE_CHANNELS = Object.values(InvokeChannel)

const EXPECTED_EVENT_CHANNELS = Object.values(EventChannel)

const EXPECTED_PRELOAD_OPERATIONS = [
  "analytics.capture => analytics:capture(event)",
  "analytics.start => analytics:start()",
  "appState.get => appState:get()",
  "appState.update => appState:update(state)",
  "diagnostics => app:diagnostics()",
  "gitProvider.approvePullRequest => gitProvider:approvePullRequest(owner, name, number)",
  "gitProvider.getPullRequestDetail => gitProvider:getPullRequestDetail(owner, name, number)",
  "gitProvider.getPullRequestDiff => gitProvider:getPullRequestDiff(owner, name, number)",
  "gitProvider.hasApprovedPullRequest => gitProvider:hasApprovedPullRequest(owner, name, number)",
  "gitProvider.listPullRequests => gitProvider:listPullRequests(owner, name)",
  "gitProvider.listReviewRequests => gitProvider:listReviewRequests()",
  "gitProvider.listSearchScopes => gitProvider:listSearchScopes()",
  "gitProvider.refreshPullRequestDetail => gitProvider:refreshPullRequestDetail(owner, name, number)",
  "gitProvider.searchRepositories => gitProvider:searchRepositories(request)",
  "installDiffDashCli => app:installDiffDashCli()",
  "localReviews.getDetail => localReviews:getDetail(target)",
  "localReviews.getDiff => localReviews:getDiff(target)",
  "localReviews.getSnapshot => localReviews:getSnapshot(target)",
  "localReviews.resolveBranch => localReviews:resolveBranch(localPath, branchName)",
  "localWalkthroughs.generate => localWalkthroughs:generate(target, false)",
  "localWalkthroughs.get => localWalkthroughs:get(target, baseSha, headSha)",
  "localWalkthroughs.regenerate => localWalkthroughs:generate(target, true)",
  "navigation.drainCommands => navigation:drainCommands()",
  "openExternalUrl => app:openExternalUrl(url)",
  "openLocalRepositoryFile => app:openLocalRepositoryFile(rootPath, filePath)",
  "openRepositoryFile => app:openRepositoryFile(owner, name, filePath, headRefName, headRefOid)",
  "repositories.addLocal => repositories:addLocal(localPath)",
  "repositories.favoriteRemote => repositories:favoriteRemote(repo)",
  "repositories.install => repositories:install(localPath)",
  "repositories.link => repositories:link(input)",
  "repositories.list => repositories:list(query)",
  "repositories.selectLocalFolder => repositories:selectLocalFolder()",
  "repositories.setFavorite => repositories:setFavorite(id, isFavorite)",
  "reviewThreads.addUserMessage => reviewThreads:addUserMessage(input)",
  "reviewThreads.create => reviewThreads:create(input)",
  "reviewThreads.get => reviewThreads:get({ threadId })",
  "reviewThreads.list => reviewThreads:list(target)",
  "reviewThreads.runAgent => reviewThreads:runAgent(input)",
  "settings.get => settings:get()",
  "settings.update => settings:update(settings)",
  "updates.check => updates:check()",
  "updates.download => updates:download()",
  "updates.getState => updates:getState()",
  "updates.restartAndInstall => updates:restartAndInstall()",
  "viewedFiles.list => viewedFiles:list(owner, name, number, headSha)",
  "viewedFiles.listLocal => viewedFiles:listLocal(rootPath, headSha)",
  "viewedFiles.set => viewedFiles:set(owner, name, number, headSha, reviewKey, filePath, viewed)",
  "viewedFiles.setLocal => viewedFiles:setLocal(rootPath, headSha, reviewKey, filePath, viewed)",
  "walkthroughs.generate => walkthroughs:generate(owner, name, number, false)",
  "walkthroughs.get => walkthroughs:get(owner, name, number, baseSha, headSha)",
  "walkthroughs.regenerate => walkthroughs:generate(owner, name, number, true)",
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

  it("locks every public preload operation to its channel and argument transformation", () => {
    expect(sortStrings(collectPreloadOperations(preload))).toEqual(
      sortStrings(EXPECTED_PRELOAD_OPERATIONS),
    )
  })

  it("keeps renderer subscriptions paired with cleanup and main emissions", () => {
    const subscribedChannels = collectCallChannels(preload, "on", "ipcRenderer")
    const removedChannels = collectCallChannels(preload, "removeListener", "ipcRenderer")
    const emittedChannels = collectCallChannels(main, "send")

    expect(new Set(subscribedChannels)).toEqual(new Set(EXPECTED_EVENT_CHANNELS))
    expect(new Set(removedChannels)).toEqual(new Set(EXPECTED_EVENT_CHANNELS))
    expect(duplicates(subscribedChannels)).toEqual([])
    expect(duplicates(removedChannels)).toEqual([])
    expect(collectListenerBindings(preload, "on")).toEqual(
      collectListenerBindings(preload, "removeListener"),
    )
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
        channel !== undefined
      ) {
        const channelName = resolveChannel(channel)
        if (channelName !== undefined) channels.push(channelName)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return channels
}

const collectPreloadOperations = (source: ts.SourceFile) => {
  const operations: string[] = []
  const visit = (node: ts.Node) => {
    const channelArgument = ts.isCallExpression(node) ? node.arguments[0] : undefined
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "invoke" &&
      channelArgument !== undefined
    ) {
      const path = propertyPath(node)
      const channel = resolveChannel(channelArgument)
      if (channel === undefined) return
      const args = node.arguments
        .slice(1)
        .map((argument) => argument.getText(source))
        .join(", ")
      operations.push(`${path} => ${channel}(${args})`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return operations
}

const propertyPath = (node: ts.Node) => {
  const names: string[] = []
  let current: ts.Node | undefined = node.parent
  while (current !== undefined) {
    if (ts.isPropertyAssignment(current)) names.unshift(current.name.getText())
    current = current.parent
  }
  return names.join(".")
}

const collectListenerBindings = (source: ts.SourceFile, method: "on" | "removeListener") => {
  const bindings: string[] = []
  const visit = (node: ts.Node) => {
    const channelArgument = ts.isCallExpression(node) ? node.arguments[0] : undefined
    const listenerArgument = ts.isCallExpression(node) ? node.arguments[1] : undefined
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "ipcRenderer" &&
      node.expression.name.text === method &&
      channelArgument !== undefined &&
      listenerArgument !== undefined
    ) {
      const channel = resolveChannel(channelArgument)
      if (channel !== undefined) bindings.push(`${channel}:${listenerArgument.getText(source)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return sortStrings(bindings)
}

const duplicates = (values: readonly string[]) => [
  ...new Set(values.filter((value, index) => values.indexOf(value) !== index)),
]

const resolveChannel = (node: ts.Expression) => {
  if (ts.isStringLiteral(node)) return node.text
  if (!ts.isPropertyAccessExpression(node)) return undefined

  if (node.expression.getText() === "InvokeChannel")
    return InvokeChannel[node.name.text as keyof typeof InvokeChannel]
  if (node.expression.getText() === "EventChannel")
    return EventChannel[node.name.text as keyof typeof EventChannel]
  return undefined
}

const sortStrings = (values: readonly string[]) => {
  const copy = [...values]
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  return copy.sort()
}
