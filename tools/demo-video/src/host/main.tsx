import { loadAtomicWebhookReplayScenario } from "@diffdash/demo/atomic-webhook-replay"
import { createDemoRuntime } from "@diffdash/demo/demo-api"
import type { DiffDashApi, DiffDashBridgeApi } from "@diffdash/protocol/api"
import { toTransportError } from "@diffdash/protocol/transport-error"
import { Effect } from "effect"
import { createRoot } from "react-dom/client"

import { encodeDemoBridgeValue } from "./bridge"
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

const wrapBridgeValue = (value: object, owner = ""): object =>
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
              value: encodeDemoBridgeValue(path, resolved),
            }),
            (error) => ({
              _tag: "Failure" as const,
              error: toTransportError(error, String(property)),
            }),
          )
        }
      }
      return typeof member === "object" && member !== null ? wrapBridgeValue(member, path) : member
    },
  })

const bridgeApi = (api: DiffDashApi): DiffDashBridgeApi => wrapBridgeValue(api) as DiffDashBridgeApi

mount().catch((cause: unknown) => {
  const message = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
  rootElement.innerHTML = `<pre class="demo-error"></pre>`
  const errorElement = rootElement.querySelector(".demo-error")
  if (errorElement !== null) errorElement.textContent = message
  document.documentElement.dataset.demoError = "true"
})
