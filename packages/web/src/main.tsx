import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { initAnalytics } from "./analytics"
import "./styles.css"

const rootElement = document.getElementById("root")

if (!rootElement) {
  throw new Error("Root element not found")
}

initAnalytics()

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
