import type { HostedReviewDetail } from "@diffdash/domain/git-provider"
import type { WebUrl } from "@diffdash/domain/web-url"
import { AlertTriangle, Check, ExternalLink, GitMerge, Loader2, RefreshCw } from "lucide-react"
import { type ReactNode, useState } from "react"

import { runRendererPromise, useDesktopRuntime } from "@/platform/renderer-runtime"
import { formatError } from "@/shared/errors"
import { Button } from "@/shared/ui/button"

/** Displays provider-neutral merge readiness and branch-update actions. */
export const HostedReviewMergeStatus = ({
  mergeState,
  onCompleted,
  providerName,
  reviewUrl,
  updateBranch,
}: {
  readonly mergeState: HostedReviewDetail["mergeState"] | null
  readonly onCompleted: () => void
  readonly providerName: string
  readonly reviewUrl: WebUrl
  readonly updateBranch: (() => Promise<void>) | null
}) => {
  const desktop = useDesktopRuntime()
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = mergeState?.status ?? "checking"

  const update = async () => {
    if (updateBranch === null) return
    setUpdating(true)
    setError(null)
    try {
      await updateBranch()
      onCompleted()
    } catch (cause) {
      setError(formatError(cause, "Could not update pull request branch"))
    } finally {
      setUpdating(false)
    }
  }

  return (
    <section className="border-border-subtle space-y-3 border-b pb-5" aria-labelledby="merge-title">
      <h2
        id="merge-title"
        className="text-muted-foreground text-xs font-semibold tracking-wide uppercase"
      >
        Merge status
      </h2>
      {status === "ready" ? (
        <StatusLine icon={<Check className="text-review-success-text" />} label="Ready to merge" />
      ) : status === "conflicting" ? (
        <div className="border-review-danger-text/25 bg-destructive/5 space-y-2.5 rounded-lg border p-3">
          <StatusLine
            icon={<AlertTriangle className="text-review-danger-text" />}
            label="Merge conflicts"
          />
          <p className="text-muted-foreground text-xs leading-5">
            {mergeState?.reason ??
              "This branch has conflicts that must be resolved before merging."}
          </p>
          <Button
            className="w-full"
            size="xs"
            variant="outline"
            onClick={() =>
              void runRendererPromise(desktop.openExternalUrl(reviewUrl)).catch(() => undefined)
            }
          >
            <ExternalLink />
            Resolve in {providerName}
          </Button>
        </div>
      ) : status === "behind" ? (
        <div className="space-y-2.5">
          <StatusLine
            icon={<RefreshCw className="text-review-modified-text" />}
            label="Branch is out of date"
          />
          <p className="text-muted-foreground text-xs leading-5">
            {mergeState?.reason ?? "Merge the latest base branch changes into this branch."}
          </p>
          {updateBranch === null ? null : (
            <Button className="w-full" size="xs" disabled={updating} onClick={() => void update()}>
              {updating ? <Loader2 className="animate-spin" /> : <GitMerge />}
              {updating ? "Updating branch..." : "Update branch"}
            </Button>
          )}
        </div>
      ) : status === "blocked" ? (
        <div className="space-y-1.5">
          <StatusLine
            icon={<AlertTriangle className="text-review-modified-text" />}
            label="Merge requirements not met"
          />
          <p className="text-muted-foreground text-xs leading-5">{mergeState?.reason}</p>
        </div>
      ) : status === "unavailable" ? (
        <div className="space-y-1.5">
          <StatusLine icon={<AlertTriangle />} label="Merge unavailable" />
          <p className="text-muted-foreground text-xs leading-5">{mergeState?.reason}</p>
        </div>
      ) : (
        <StatusLine icon={<Loader2 className="animate-spin" />} label="Checking merge status..." />
      )}
      {error === null ? null : (
        <p role="alert" className="text-review-danger-text text-xs leading-5">
          {error}
        </p>
      )}
    </section>
  )
}

const StatusLine = ({ icon, label }: { readonly icon: ReactNode; readonly label: string }) => (
  <p className="flex items-center gap-2 text-sm font-medium [&_svg]:size-3.5">
    {icon}
    {label}
  </p>
)
