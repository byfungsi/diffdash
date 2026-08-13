import { Download, Loader2, RefreshCw, RotateCcw, X } from "lucide-react"
import { useState } from "react"
import { Match } from "effect"

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
  const projection = updateBannerProjection(state)

  if (
    projection === null ||
    (projection.dismissalKey !== null && dismissedVersion === projection.dismissalKey)
  )
    return null

  return (
    <aside
      aria-live="polite"
      className="bg-card text-card-foreground fixed right-4 bottom-4 z-50 w-[min(24rem,calc(100vw-2rem))] rounded-xl border p-4 shadow-lg"
    >
      <div className="flex items-start gap-3">
        <div className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-lg">
          {projection.icon === "download" ? <Download className="size-4" /> : null}
          {projection.icon === "loading" ? <Loader2 className="size-4 animate-spin" /> : null}
          {projection.icon === "restart" ? <RotateCcw className="size-4" /> : null}
          {projection.icon === "retry" ? <RefreshCw className="size-4" /> : null}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{projection.title}</div>
          <p className="text-muted-foreground mt-1 text-xs leading-5">{projection.detail}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {projection.action === "download" ? (
              <Button size="sm" onClick={onDownload}>
                Download update
              </Button>
            ) : null}
            {projection.action === "restart" ? (
              <Button size="sm" onClick={onRestart}>
                Restart and update
              </Button>
            ) : null}
            {projection.action === "restart" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDismissedVersion(projection.dismissalKey)}
              >
                Later
              </Button>
            ) : null}
            {projection.action === "retry" ? (
              <Button size="sm" variant="outline" onClick={onCheck}>
                Try again
              </Button>
            ) : null}
          </div>
        </div>
        {projection.dismissible ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss update notice"
            onClick={() => setDismissedVersion(projection.dismissalKey)}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </aside>
  )
}

type UpdateBannerProjection = {
  readonly action: "download" | "restart" | "retry" | null
  readonly detail: string
  readonly dismissible: boolean
  readonly dismissalKey: string | null
  readonly icon: "download" | "loading" | "restart" | "retry"
  readonly title: string
}

const updateBannerProjection = (state: AppUpdateState): UpdateBannerProjection | null => {
  return Match.valueTags(state, {
    idle: () => null,
    unsupported: () => null,
    checking: () =>
      ({
        action: null,
        detail: "Looking for a newer stable release.",
        dismissible: false,
        dismissalKey: null,
        icon: "loading",
        title: "Checking for updates",
      }) as const,
    available: (available) =>
      ({
        action: "download",
        detail: "Download it now and choose when to restart.",
        dismissible: true,
        dismissalKey: available.version,
        icon: "download",
        title: `DiffDash v${available.version} is available`,
      }) as const,
    downloading: (downloading) =>
      ({
        action: null,
        detail: `${Math.round(downloading.percent)}% downloaded.`,
        dismissible: false,
        dismissalKey: null,
        icon: "loading",
        title: `Downloading DiffDash v${downloading.version}`,
      }) as const,
    downloaded: (downloaded) =>
      ({
        action: "restart",
        detail: "Restart when you are ready to install the update.",
        dismissible: false,
        dismissalKey: downloaded.version,
        icon: "restart",
        title: `DiffDash v${downloaded.version} is ready`,
      }) as const,
    error: (failed) =>
      ({
        action: "retry",
        detail: failed.message,
        dismissible: true,
        dismissalKey: failed.currentVersion,
        icon: "retry",
        title: "Update failed",
      }) as const,
  })
}
