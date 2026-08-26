import type { HostedReviewCheck, HostedReviewCheckStatus } from "@diffdash/domain/git-provider"
import type { WebUrl } from "@diffdash/domain/web-url"
import {
  Ban,
  Check,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  ExternalLink,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react"
import { useState } from "react"

import { runRendererPromise, useDesktopRuntime } from "@/platform/renderer-runtime"
import { Button } from "@/shared/ui/button"
import { cn } from "@/shared/utils"

const COLLAPSED_CHECK_COUNT = 5
const statusOrder: Readonly<Record<HostedReviewCheckStatus, number>> = {
  failed: 0,
  pending: 1,
  cancelled: 2,
  passed: 3,
  skipped: 4,
}

/** Provider-neutral CI summary for the hosted review status rail. */
export const HostedReviewChecks = ({
  checks,
  error,
  loading,
  onRefresh,
  providerName,
}: {
  readonly checks: readonly HostedReviewCheck[]
  readonly error: string | null
  readonly loading: boolean
  readonly onRefresh: () => void
  readonly providerName: string
}) => {
  const desktop = useDesktopRuntime()
  const [expanded, setExpanded] = useState(false)
  const sortedChecks = [...checks].sort(
    (left, right) => statusOrder[left.status] - statusOrder[right.status],
  )
  const visibleChecks = expanded ? sortedChecks : sortedChecks.slice(0, COLLAPSED_CHECK_COUNT)
  const hiddenCount = sortedChecks.length - visibleChecks.length
  const failedCount = checks.filter(({ status }) => status === "failed").length
  const pendingCount = checks.filter(({ status }) => status === "pending").length
  const passedCount = checks.filter(({ status }) => status === "passed").length
  const openCheck = (detailsUrl: WebUrl) => () => {
    void runRendererPromise(desktop.openExternalUrl(detailsUrl)).catch(() => undefined)
  }

  return (
    <section
      className="border-border-subtle space-y-3 border-b pb-5"
      aria-labelledby="checks-title"
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          id="checks-title"
          className="text-muted-foreground text-xs font-semibold tracking-wide uppercase"
        >
          Checks
        </h2>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Refresh checks from ${providerName}`}
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
        </Button>
      </div>

      {error !== null ? (
        <div className="space-y-2">
          <p className="text-review-danger-text text-xs leading-5">{error}</p>
          <Button size="xs" variant="outline" onClick={onRefresh}>
            Retry checks
          </Button>
        </div>
      ) : loading && checks.length === 0 ? (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="size-3 animate-spin" />
          Loading checks...
        </p>
      ) : checks.length === 0 ? (
        <p className="text-muted-foreground text-xs">No checks reported.</p>
      ) : (
        <>
          <p className="text-sm font-medium" aria-live="polite">
            {checkSummary(failedCount, pendingCount, passedCount, checks.length)}
          </p>
          <div className="space-y-1.5">
            {visibleChecks.map((check) => (
              <div
                key={`${check.workflow ?? "check"}:${check.name}:${check.startedAt ?? "unknown"}:${check.detailsUrl ?? "no-url"}`}
                className="border-border-subtle bg-muted/30 rounded-md border px-2.5 py-2"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <CheckStatusIcon status={check.status} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium" title={check.name}>
                      {check.name}
                    </p>
                    {check.workflow === null ? null : (
                      <p
                        className="text-muted-foreground truncate text-[11px]"
                        title={check.workflow}
                      >
                        {check.workflow}
                      </p>
                    )}
                  </div>
                  {check.detailsUrl === null ? null : (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Open ${check.name} in ${providerName}`}
                      onClick={openCheck(check.detailsUrl)}
                    >
                      <ExternalLink />
                    </Button>
                  )}
                </div>
                {check.status === "failed" && check.detailsUrl !== null ? (
                  <button
                    type="button"
                    className="text-review-danger-text mt-1.5 text-[11px] font-medium hover:underline"
                    onClick={openCheck(check.detailsUrl)}
                  >
                    Open failed check in {providerName}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          {hiddenCount > 0 || expanded ? (
            <Button
              className="w-full"
              size="xs"
              variant="ghost"
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? <ChevronUp /> : <ChevronDown />}
              {expanded ? "Show fewer checks" : `Show ${hiddenCount} more`}
            </Button>
          ) : null}
        </>
      )}
    </section>
  )
}

const CheckStatusIcon = ({ status }: { readonly status: HostedReviewCheckStatus }) => {
  if (status === "passed") return <Check className="text-review-success-text mt-0.5 size-3.5" />
  if (status === "failed") return <X className="text-review-danger-text mt-0.5 size-3.5" />
  if (status === "pending") return <CircleDashed className="mt-0.5 size-3.5 animate-spin" />
  return <Ban className="text-muted-foreground mt-0.5 size-3.5" />
}

const checkSummary = (failed: number, pending: number, passed: number, total: number): string => {
  if (failed > 0)
    return `${failed} failed, ${passed} passed${pending > 0 ? `, ${pending} pending` : ""}`
  if (pending > 0) return `${pending} pending, ${passed} passed`
  if (passed === total) return `All ${total} checks passed`
  return `${passed} of ${total} checks passed`
}
