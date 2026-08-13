import { describe, expect, it } from "@effect/vitest"
import { request as httpRequest } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { DiffDashReviewMcpTool } from "@diffdash/protocol/mcp"
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Result,
  Schema,
  Scope,
} from "effect"
import { DiffDashMcpServer } from "./mcp-server"
import { DiffDashMcpToolError } from "./port"
import type {
  DiffDashMcpRunAccess,
  DiffDashMcpRunContext,
  DiffDashMcpServerLayerOptions,
  DiffDashMcpToolHandlers,
} from "./port"

const available = (data: object) => ({
  status: "available" as const,
  data: Schema.decodeUnknownSync(Schema.Json)(data),
})
const unavailable = { status: "unavailable" as const, reason: "Unused test handler" }

const handlers: DiffDashMcpToolHandlers = {
  execute: (request) => {
    switch (request.tool) {
      case DiffDashReviewMcpTool.getReviewContext:
        return Effect.succeed(available({ kind: "local", title: "Test review" }))
      case DiffDashReviewMcpTool.getChangedFiles:
        return Effect.succeed(
          available({
            offset: request.offset,
            limit: request.limit,
            files: [],
            totalFiles: 0,
            hasMore: false,
            nextOffset: null,
          }),
        )
      case DiffDashReviewMcpTool.searchReviewDiff:
        return Effect.succeed(available({ matches: [], total: 0 }))
      default:
        return Effect.succeed(unavailable)
    }
  },
}

const runContext = (
  maxToolOutputBytes?: number,
  contextHandlers: DiffDashMcpToolHandlers = handlers,
): DiffDashMcpRunContext => ({
  runId: "run-test",
  threadId: "thread-test",
  repoId: "repo-test",
  localPath: null,
  handlers: contextHandlers,
  ...(maxToolOutputBytes === undefined ? {} : { maxToolOutputBytes }),
})

const makeTestLayer = (options: DiffDashMcpServerLayerOptions = {}) =>
  DiffDashMcpServer.layerWith(options)

const authorizedHeaders = (access: DiffDashMcpRunAccess) => ({
  accept: "application/json, text/event-stream",
  authorization: `Bearer ${Redacted.value(access.bearerToken)}`,
  "content-type": "application/json",
})

const toolText = (result: unknown) => {
  if (typeof result !== "object" || result === null || !("content" in result)) return ""
  if (!Array.isArray(result.content)) return ""
  for (const item of result.content) {
    if (
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string"
    ) {
      return item.text
    }
  }
  return ""
}

const connectClient = (access: DiffDashMcpRunAccess) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const client = new Client({ name: "diffdash-mcp-test", version: "1" })
      const transport = new StreamableHTTPClientTransport(new URL(access.url), {
        requestInit: { headers: authorizedHeaders(access) },
      })
      // SAFETY: The SDK's callback optionality conflicts with exactOptionalPropertyTypes.
      await client.connect(transport as Transport)
      return client
    }),
    (client) => Effect.promise(() => client.close()),
  )

describe("DiffDashMcpServer", () => {
  it.effect("requires and revokes a scoped bearer capability", () =>
    Effect.gen(function* () {
      const server = yield* DiffDashMcpServer
      const access = yield* server.acquireRun(runContext())
      const unauthorized = yield* Effect.promise(() =>
        fetch(access.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        }),
      )
      expect(unauthorized.status).toBe(401)
      expect(Redacted.value(access.bearerToken)).toHaveLength(64)

      const revoked = yield* Effect.scoped(
        server
          .acquireRun(runContext())
          .pipe(Effect.map((temporary) => ({ url: temporary.url, token: temporary.bearerToken }))),
      )
      const afterRevoke = yield* Effect.promise(() =>
        fetch(revoked.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${Redacted.value(revoked.token)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        }),
      )
      expect(afterRevoke.status).toBe(401)
    }).pipe(Effect.provide(makeTestLayer())),
  )

  it.effect("registers read-only tools and routes validated input through Core handlers", () =>
    Effect.gen(function* () {
      const server = yield* DiffDashMcpServer
      const access = yield* server.acquireRun(runContext(400))
      const client = yield* connectClient(access)
      const tools = yield* Effect.promise(() => client.listTools())
      const changedFiles = yield* Effect.promise(() =>
        client.callTool({
          name: DiffDashReviewMcpTool.getChangedFiles,
          arguments: { offset: 4, limit: 2 },
        }),
      )
      const invalid = yield* Effect.promise(() =>
        client.callTool({
          name: DiffDashReviewMcpTool.getChangedFiles,
          arguments: { limit: 0 },
        }),
      )
      const context = yield* Effect.promise(() =>
        client.callTool({ name: DiffDashReviewMcpTool.getReviewContext, arguments: {} }),
      )

      expect(tools.tools).toHaveLength(11)
      expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true)
      expect(toolText(changedFiles)).toContain('"offset":4')
      expect(toolText(changedFiles)).toContain('"limit":2')
      expect(invalid.isError).toBe(true)
      expect(toolText(context)).toContain('"kind":"local"')
      expect(Buffer.byteLength(toolText(context), "utf8")).toBeLessThanOrEqual(400)
      yield* Effect.promise(() => client.close())
    }).pipe(Effect.scoped, Effect.provide(makeTestLayer())),
  )

  it.effect("hard-bounds tool output and request bodies", () =>
    Effect.gen(function* () {
      const server = yield* DiffDashMcpServer
      const access = yield* server.acquireRun(runContext(16))
      const response = yield* Effect.promise(() =>
        fetch(access.url, {
          method: "POST",
          headers: authorizedHeaders(access),
          body: "x".repeat(1024 * 1024 + 1),
        }),
      )
      expect(response.status).toBe(413)

      const client = yield* connectClient(access)
      const context = yield* Effect.promise(() =>
        client.callTool({ name: DiffDashReviewMcpTool.getReviewContext, arguments: {} }),
      )
      expect(Buffer.byteLength(toolText(context), "utf8")).toBeLessThanOrEqual(16)
      yield* Effect.promise(() => client.close())
    }).pipe(Effect.scoped, Effect.provide(makeTestLayer())),
  )

  it.effect("linearizes admitted requests before capability revocation", () =>
    Effect.gen(function* () {
      const admitted = yield* Deferred.make<void>()
      const releaseRequest = yield* Deferred.make<void>()
      const revoking = promiseDeferred<void>()

      yield* Effect.gen(function* () {
        const server = yield* DiffDashMcpServer
        const capabilityScope = yield* Scope.make()
        const access = yield* server
          .acquireRun(runContext())
          .pipe(Effect.provideService(Scope.Scope, capabilityScope))
        const firstRequest = yield* Effect.promise(() => initialize(access)).pipe(Effect.forkChild)
        yield* Deferred.await(admitted)

        const closeFiber = yield* Scope.close(capabilityScope, Exit.void).pipe(Effect.forkChild)
        yield* Effect.promise(() => revoking.promise)
        expect((yield* Effect.promise(() => initialize(access))).status).toBe(401)

        yield* Deferred.succeed(releaseRequest, undefined)
        expect((yield* Fiber.join(firstRequest)).status).toBe(200)
        yield* Fiber.join(closeFiber)
      }).pipe(
        Effect.provide(
          makeTestLayer({
            capabilityGraceMs: 500,
            hooks: {
              onCapabilityRevoking: () => revoking.resolve(undefined),
              onHttpRequest: Deferred.succeed(admitted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRequest)),
              ),
            },
          }),
        ),
      )
    }),
  )

  it.effect("interrupts only the revoked capability's exact in-flight tool fiber", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>()
      const firstFinalized = yield* Deferred.make<void>()
      const blockedHandlers: DiffDashMcpToolHandlers = {
        execute: (request) =>
          request.tool === DiffDashReviewMcpTool.getReviewContext
            ? Deferred.succeed(firstStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(firstFinalized, undefined)),
              )
            : Effect.succeed(unavailable),
      }

      const server = yield* DiffDashMcpServer
      const firstScope = yield* Scope.make()
      const firstAccess = yield* server
        .acquireRun(runContext(undefined, blockedHandlers))
        .pipe(Effect.provideService(Scope.Scope, firstScope))
      const secondAccess = yield* server.acquireRun(runContext())
      const firstClient = yield* connectClient(firstAccess)
      const secondClient = yield* connectClient(secondAccess)
      const firstCall = yield* Effect.promise(() =>
        firstClient.callTool({ name: DiffDashReviewMcpTool.getReviewContext, arguments: {} }),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)

      yield* Scope.close(firstScope, Exit.void)
      yield* Deferred.await(firstFinalized)
      const secondResult = yield* Effect.promise(() =>
        secondClient.callTool({ name: DiffDashReviewMcpTool.getReviewContext, arguments: {} }),
      )

      expect(toolText(secondResult)).toContain('"kind":"local"')
      yield* Fiber.interrupt(firstCall)
      yield* Effect.promise(() => Promise.all([firstClient.close(), secondClient.close()]))
    }).pipe(
      Effect.scoped,
      Effect.provide(makeTestLayer({ capabilityGraceMs: 0, requestFinalizerMs: 200 })),
    ),
  )

  it.effect("surfaces a squashed typed tool failure through the Promise callback boundary", () =>
    Effect.gen(function* () {
      const failingHandlers: DiffDashMcpToolHandlers = {
        execute: (request) =>
          DiffDashMcpToolError.make({
            operation: request.tool,
            reason: "squashed failure sentinel",
          }),
      }
      const server = yield* DiffDashMcpServer
      const access = yield* server.acquireRun(runContext(undefined, failingHandlers))
      const client = yield* connectClient(access)
      const result = yield* Effect.promise(() =>
        client.callTool({ name: DiffDashReviewMcpTool.getReviewContext, arguments: {} }),
      )

      expect(result.isError).toBe(true)
      yield* Effect.promise(() => client.close())
    }).pipe(Effect.scoped, Effect.provide(makeTestLayer())),
  )

  it.effect("bounds layer shutdown and rejects callbacks admitted after shutdown begins", () =>
    Effect.gen(function* () {
      const admitted = yield* Deferred.make<void>()
      let callbacks = 0
      const layer = makeTestLayer({
        capabilityGraceMs: 0,
        requestFinalizerMs: 100,
        httpCloseMs: 25,
        httpForceCloseMs: 25,
        hooks: {
          onHttpRequest: Effect.sync(() => {
            callbacks += 1
          }).pipe(Effect.andThen(Deferred.succeed(admitted, undefined))),
        },
      })
      const layerScope = yield* Scope.make()
      const services = yield* Layer.buildWithScope(layer, layerScope)
      const server = Context.get(services, DiffDashMcpServer)
      const capabilityScope = yield* Scope.make()
      const access = yield* server
        .acquireRun(runContext())
        .pipe(Effect.provideService(Scope.Scope, capabilityScope))
      const request = openPartialRequest(access)
      request.write("{")
      yield* Deferred.await(admitted)

      expect(yield* completesWithin(Scope.close(layerScope, Exit.void), 300)).toBe(true)
      const callbackCount = callbacks
      const afterClose = yield* Effect.tryPromise(() => initialize(access)).pipe(Effect.result)
      expect(Result.isFailure(afterClose)).toBe(true)
      expect(callbacks).toBe(callbackCount)
      request.destroy()
      yield* Scope.close(capabilityScope, Exit.void)
    }),
  )

  it.effect(
    "does not let an uninterruptible callback finalizer outwait bounded layer shutdown",
    () =>
      Effect.gen(function* () {
        const admitted = yield* Deferred.make<void>()
        const cleanupErrors: string[] = []
        const layerScope = yield* Scope.make()
        const services = yield* Layer.buildWithScope(
          makeTestLayer({
            capabilityGraceMs: 0,
            requestFinalizerMs: 25,
            httpCloseMs: 25,
            httpForceCloseMs: 25,
            hooks: {
              onCleanupError: (operation) => cleanupErrors.push(operation),
              onHttpRequest: Deferred.succeed(admitted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Effect.uninterruptible(Effect.never)),
              ),
            },
          }),
          layerScope,
        )
        const server = Context.get(services, DiffDashMcpServer)
        const capabilityScope = yield* Scope.make()
        const access = yield* server
          .acquireRun(runContext())
          .pipe(Effect.provideService(Scope.Scope, capabilityScope))
        const request = openPartialRequest(access)
        request.write("{")
        yield* Deferred.await(admitted)

        expect(yield* completesWithin(Scope.close(layerScope, Exit.void), 250)).toBe(true)
        expect(cleanupErrors).toContain("capability.requestFinalizers")
        expect(cleanupErrors).toContain("runtime.callbackFinalizers")
        request.destroy()
        yield* Scope.close(capabilityScope, Exit.void)
      }),
  )
})

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "diffdash-lifecycle-test", version: "1" },
  },
})

const initialize = (access: DiffDashMcpRunAccess) =>
  fetch(access.url, {
    method: "POST",
    headers: authorizedHeaders(access),
    body: INITIALIZE_BODY,
  })

const openPartialRequest = (access: DiffDashMcpRunAccess) => {
  const request = httpRequest(
    access.url,
    { method: "POST", headers: authorizedHeaders(access) },
    (response) => response.resume(),
  )
  request.on("error", () => undefined)
  return request
}

const completesWithin = <A, E, R>(effect: Effect.Effect<A, E, R>, milliseconds: number) =>
  Effect.raceFirst(
    effect.pipe(Effect.exit, Effect.as(true)),
    Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))).pipe(
      Effect.as(false),
    ),
  )

const promiseDeferred = <A>() => {
  let complete: ((value: A | PromiseLike<A>) => void) | undefined
  const promise = new Promise<A>((resolve) => {
    complete = resolve
  })
  return {
    promise,
    resolve: (value: A | PromiseLike<A>) => complete?.(value),
  }
}
