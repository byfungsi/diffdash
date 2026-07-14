import { lazy, StrictMode, Suspense } from "react"
import { createRoot } from "react-dom/client"

import { AppErrorBoundary, AppErrorFallback } from "./app-error-boundary"
import "./styles.css"

const LazyApp = lazy(() => import("./app").then(({ App }) => ({ default: App })))
const existingRootElement = document.getElementById("root")
const rootElement = existingRootElement ?? document.body.appendChild(document.createElement("div"))

if (existingRootElement === null) rootElement.id = "root"

function AppLoadingFallback() {
  return (
    <main className="bg-background text-muted-foreground flex min-h-dvh items-center justify-center p-6 text-sm">
      Loading DiffDash...
    </main>
  )
}

createRoot(rootElement).render(
  <StrictMode>
    {existingRootElement === null ? (
      <AppErrorFallback
        errorMessage="Root element #root was not found."
        onReload={() => window.location.reload()}
      />
    ) : (
      <AppErrorBoundary>
        <Suspense fallback={<AppLoadingFallback />}>
          <LazyApp />
        </Suspense>
      </AppErrorBoundary>
    )}
  </StrictMode>,
)
