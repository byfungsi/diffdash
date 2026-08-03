import { loadAtomicWebhookReplayScenario } from "@diffdash/demo/atomic-webhook-replay"
import { createDemoRuntime } from "@diffdash/demo/demo-api"
import { Effect } from "effect"
import { createRoot } from "react-dom/client"

import "./styles.css"

const rootElement = document.getElementById("root")
if (rootElement === null) throw new Error("Demo video root is missing")

const mount = async () => {
  document.documentElement.classList.add("dark")
  localStorage.setItem("diffdash-theme", "dark")

  const scenario = await Effect.runPromise(loadAtomicWebhookReplayScenario)
  const runtime = createDemoRuntime(scenario)
  Object.defineProperty(window, "diffDash", { configurable: false, value: runtime.api })
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

mount().catch((cause: unknown) => {
  const message = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
  rootElement.innerHTML = `<pre class="demo-error"></pre>`
  const errorElement = rootElement.querySelector(".demo-error")
  if (errorElement !== null) errorElement.textContent = message
  document.documentElement.dataset.demoError = "true"
})
