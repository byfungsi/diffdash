import { Download, Loader2, RefreshCw, RotateCcw, X } from "lucide-react"
import { useState } from "react"

import { Button } from "@/shared/ui/button"
import type { AppUpdateState } from "@diffdash/protocol/app-update"

/** Global automatic-update status and actions. */
export const UpdateBanner = ({
  state,
  onCheck,
  onDownload,
  onRestart,
}: {
  readonly state: AppUpdateState
  readonly onCheck: () => void
  readonly onDownload: () => void
  readonly onRestart: () => void
}) => {
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
  const version = "version" in state ? state.version : null

  if (state["_tag"] === "idle" || state["_tag"] === "unsupported") return null
  if (
    (state["_tag"] === "available" || state["_tag"] === "downloaded") &&
    dismissedVersion === state.version
  )
    return null
  if (state["_tag"] === "error" && dismissedVersion === state.currentVersion) return null

  return (
    <aside
      aria-live="polite"
      className="bg-card text-card-foreground fixed right-4 bottom-4 z-50 w-[min(24rem,calc(100vw-2rem))] rounded-xl border p-4 shadow-lg"
    >
      <div className="flex items-start gap-3">
        <div className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-lg">
          {state["_tag"] === "available" ? <Download className="size-4" /> : null}
          {state["_tag"] === "checking" || state["_tag"] === "downloading" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : null}
          {state["_tag"] === "downloaded" ? <RotateCcw className="size-4" /> : null}
          {state["_tag"] === "error" ? <RefreshCw className="size-4" /> : null}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{updateTitle(state)}</div>
          <p className="text-muted-foreground mt-1 text-xs leading-5">{updateDetail(state)}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {state["_tag"] === "available" ? (
              <Button size="sm" onClick={onDownload}>
                Download update
              </Button>
            ) : null}
            {state["_tag"] === "downloaded" ? (
              <Button size="sm" onClick={onRestart}>
                Restart and update
              </Button>
            ) : null}
            {state["_tag"] === "downloaded" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDismissedVersion(state.version)}
              >
                Later
              </Button>
            ) : null}
            {state["_tag"] === "error" ? (
              <Button size="sm" variant="outline" onClick={onCheck}>
                Try again
              </Button>
            ) : null}
          </div>
        </div>
        {state["_tag"] === "available" || state["_tag"] === "error" ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss update notice"
            onClick={() => setDismissedVersion(version ?? state.currentVersion)}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </aside>
  )
}

const updateTitle = (state: AppUpdateState) => {
  if (state["_tag"] === "checking") return "Checking for updates"
  if (state["_tag"] === "available") return `DiffDash v${state.version} is available`
  if (state["_tag"] === "downloading") return `Downloading DiffDash v${state.version}`
  if (state["_tag"] === "downloaded") return `DiffDash v${state.version} is ready`
  if (state["_tag"] === "error") return "Update failed"
  return "DiffDash updates"
}

const updateDetail = (state: AppUpdateState) => {
  if (state["_tag"] === "checking") return "Looking for a newer stable release."
  if (state["_tag"] === "available") return "Download it now and choose when to restart."
  if (state["_tag"] === "downloading") return `${Math.round(state.percent)}% downloaded.`
  if (state["_tag"] === "downloaded") return "Restart when you are ready to install the update."
  if (state["_tag"] === "error") return state.message
  return ""
}
