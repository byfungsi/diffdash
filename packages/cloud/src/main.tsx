import { AppErrorBoundary } from "@diffdash/app"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { CloudRoot } from "./cloud-root"
import { captureCloudEvent } from "./cloud-analytics"
import "./cloud.css"

const existingRootElement = document.getElementById("root")
const rootElement = existingRootElement ?? document.body.appendChild(document.createElement("div"))
if (existingRootElement === null) rootElement.id = "root"
void captureCloudEvent({ event: "cloud_opened" })

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <CloudRoot />
    </AppErrorBoundary>
  </StrictMode>,
)
