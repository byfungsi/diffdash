import { loadAtomicWebhookReplayScenario } from "@diffdash/demo/atomic-webhook-replay"
import { createDemoRuntime } from "@diffdash/demo/demo-api"
import type { DiffDashApi, DiffDashBridgeApi } from "@diffdash/protocol/api"
import {
  CodeWorkspaceLease,
  RepositoryLanguageLocationResult,
} from "@diffdash/protocol/code-workspace"
import { toTransportError } from "@diffdash/protocol/transport-error"
import { Effect, Schema } from "effect"
import { createRoot } from "react-dom/client"

import "./styles.css"

const rootElement = document.getElementById("root")
if (rootElement === null) throw new Error("Demo video root is missing")

const mount = async () => {
  document.documentElement.classList.add("dark")
  localStorage.setItem("diffdash-theme", "dark")

  const scenario = await Effect.runPromise(loadAtomicWebhookReplayScenario)
  const runtime = createDemoRuntime(scenario)
  Object.defineProperty(window, "diffDash", {
    configurable: false,
    value: bridgeApi(runtime.api),
  })
  Object.defineProperty(window, "__diffDashDemo", {
    configurable: false,
    value: runtime.timeline,
  })

  const { App } = await import("@diffdash/app")
  rootElement.replaceChildren()
  createRoot(rootElement).render(<App />)
  await document.fonts.ready
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      document.documentElement.dataset.demoReady = "true"
    }),
  )
}

const bridgeApi = (api: DiffDashApi): DiffDashBridgeApi => {
  const wrap = (value: object, owner = ""): object =>
    new Proxy(value, {
      get(target, property, receiver) {
        const member = Reflect.get(target, property, receiver)
        const path = owner.length === 0 ? String(property) : `${owner}.${String(property)}`
        if (typeof member === "function") {
          return (...arguments_: unknown[]) => {
            const result = Reflect.apply(member, receiver, arguments_)
            if (!(result instanceof Promise)) return result
            return result.then(
              (resolved) => ({
                _tag: "Success" as const,
                value: encodeBridgeValue(path, resolved),
              }),
              (error) => ({
                _tag: "Failure" as const,
                error: toTransportError(error, String(property)),
              }),
            )
          }
        }
        return typeof member === "object" && member !== null ? wrap(member, path) : member
      },
    })

  return wrap(api) as DiffDashBridgeApi
}

const encodeBridgeValue = (path: string, value: unknown): unknown => {
  if (
    (path === "codeWorkspace.open" || path === "codeWorkspace.heartbeat") &&
    Schema.is(CodeWorkspaceLease)(value)
  ) {
    return Schema.encodeSync(CodeWorkspaceLease)(value)
  }
  if (
    (path === "codeWorkspace.definitions" || path === "codeWorkspace.references") &&
    Schema.is(RepositoryLanguageLocationResult)(value)
  ) {
    return Schema.encodeSync(RepositoryLanguageLocationResult)(value)
  }
  if (path === "codeWorkspace.release") return null
  return value
}

mount().catch((cause: unknown) => {
  const message = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
  rootElement.innerHTML = `<pre class="demo-error"></pre>`
  const errorElement = rootElement.querySelector(".demo-error")
  if (errorElement !== null) errorElement.textContent = message
  document.documentElement.dataset.demoError = "true"
})
