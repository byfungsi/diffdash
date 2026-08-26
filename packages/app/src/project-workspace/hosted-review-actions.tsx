import type { HostedReviewDetail, ReviewDecision } from "@diffdash/domain/git-provider"
import { Check, GitMerge, Loader2, MessageSquare, MoreHorizontal } from "lucide-react"
import { DropdownMenu } from "radix-ui"
import { useRef, useState } from "react"

import { formatError } from "@/shared/errors"
import { Button } from "@/shared/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog"
import { AnchoredFloatingPane } from "@/shared/ui/floating-pane"
import { MarkdownContent } from "@/shared/ui/markdown-content"
import { Textarea } from "@/shared/ui/textarea"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip"
import { cn } from "@/shared/utils"

/** Review decisions that can be submitted to a hosted provider. */
export type HostedReviewSubmissionDecision = Exclude<ReviewDecision, "none">

/** Deterministic merge methods exposed by the hosted review overview. */
export type HostedReviewMergeMethod = "merge" | "squash" | "rebase"

/** Provider-backed mutations available from the hosted review overview. */
export type HostedReviewActionOperations = {
  readonly close: (() => Promise<void>) | null
  readonly merge: ((method: HostedReviewMergeMethod, bypassRules: boolean) => Promise<void>) | null
  readonly mergeBypassSupported: boolean
  readonly updateBranch: (() => Promise<void>) | null
  readonly submit:
    | ((decision: HostedReviewSubmissionDecision, body: string) => Promise<void>)
    | null
}

/** Header commands and confirmation dialogs for hosted review mutations. */
export function HostedReviewActions({
  mergeState,
  operations,
  onCompleted,
}: {
  readonly mergeState: HostedReviewDetail["mergeState"] | null
  readonly operations: HostedReviewActionOperations
  readonly onCompleted: () => void
}) {
  const [dialog, setDialog] = useState<"merge" | "close" | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [decision, setDecision] = useState<HostedReviewSubmissionDecision>("approved")
  const [mergeMethod, setMergeMethod] = useState<HostedReviewMergeMethod>("squash")
  const [bypassRules, setBypassRules] = useState(false)
  const [body, setBody] = useState("")
  const [preview, setPreview] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reviewButtonRef = useRef<HTMLButtonElement>(null)
  const mergeButtonRef = useRef<HTMLButtonElement>(null)
  const available =
    operations.submit !== null || operations.merge !== null || operations.close !== null

  if (!available) return null

  const closeDialog = () => {
    if (submitting) return
    setDialog(null)
    setBypassRules(false)
    setError(null)
  }
  const closeReview = () => {
    if (submitting) return
    setReviewOpen(false)
    setError(null)
  }
  const runAction = async (action: () => Promise<void>, failureMessage: string) => {
    setSubmitting(true)
    setError(null)
    try {
      await action()
      setDialog(null)
      setReviewOpen(false)
      setBody("")
      onCompleted()
    } catch (cause) {
      setError(formatError(cause, failureMessage))
    } finally {
      setSubmitting(false)
    }
  }
  const bodyRequired = decision !== "approved"
  const mergeDisabledReason = mergeStateReason(mergeState)
  const bypassAvailable = operations.mergeBypassSupported && mergeState?.status === "blocked"
  const mergeButtonDisabled = mergeDisabledReason !== null && !bypassAvailable
  const mergeSubmissionAllowed = mergeState?.status === "ready" || (bypassAvailable && bypassRules)

  return (
    <>
      <div className="flex items-center gap-2">
        {operations.submit === null ? null : (
          <Button
            ref={reviewButtonRef}
            variant="outline"
            aria-expanded={reviewOpen}
            aria-haspopup="dialog"
            onClick={() => {
              setError(null)
              setReviewOpen((current) => !current)
            }}
          >
            <MessageSquare />
            Review
          </Button>
        )}
        {operations.merge === null ? null : (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    ref={mergeButtonRef}
                    variant="secondary"
                    disabled={mergeButtonDisabled}
                    aria-expanded={dialog === "merge"}
                    aria-haspopup="dialog"
                    onClick={() => {
                      setBypassRules(false)
                      setDialog("merge")
                    }}
                  >
                    <GitMerge />
                    Merge
                  </Button>
                </span>
              </TooltipTrigger>
              {!mergeButtonDisabled || mergeDisabledReason === null ? null : (
                <TooltipContent>{mergeDisabledReason}</TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        )}
        {operations.close === null ? null : (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button variant="ghost" size="icon" aria-label="More pull request actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="bg-popover text-popover-foreground z-50 min-w-44 rounded-lg border p-1 shadow-search-floating"
              >
                <DropdownMenu.Item
                  className="text-destructive data-[highlighted]:bg-destructive/10 cursor-default rounded-md px-2.5 py-2 text-xs outline-none"
                  onSelect={() => setDialog("close")}
                >
                  Close pull request
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>

      {!reviewOpen || reviewButtonRef.current === null ? null : (
        <AnchoredFloatingPane
          align="end"
          anchor={reviewButtonRef.current}
          ariaLabel="Submit review"
          className="w-[min(30rem,calc(100vw-2rem))]"
          side="bottom"
          sideOffset={8}
          onClose={closeReview}
        >
          <div className="max-h-[min(38rem,var(--radix-popover-content-available-height))] space-y-4 overflow-y-auto p-4">
            <header className="space-y-1">
              <h2 className="text-sm font-semibold">Submit review</h2>
              <p className="text-muted-foreground text-xs leading-5">
                Leave a Markdown comment and choose how this review should be recorded.
              </p>
            </header>
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
              {reviewDecisionOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={cn(
                    "rounded-md px-2 py-2 text-xs font-medium transition-colors",
                    decision === option.value
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setDecision(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor="hosted-review-body" className="text-xs font-medium">
                  Comment {bodyRequired ? "(required)" : "(optional)"}
                </label>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground text-xs"
                  onClick={() => setPreview((current) => !current)}
                >
                  {preview ? "Write" : "Preview"}
                </button>
              </div>
              {preview ? (
                <div className="bg-surface-inset min-h-32 rounded-lg border p-3">
                  {body.trim().length === 0 ? (
                    <p className="text-muted-foreground text-sm">Nothing to preview.</p>
                  ) : (
                    <MarkdownContent>{body}</MarkdownContent>
                  )}
                </div>
              ) : (
                <Textarea
                  id="hosted-review-body"
                  value={body}
                  rows={7}
                  placeholder="Leave a review comment"
                  onChange={(event) => setBody(event.target.value)}
                />
              )}
            </div>
            <ActionError>{error}</ActionError>
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button variant="ghost" onClick={closeReview} disabled={submitting}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const submit = operations.submit
                  if (submit !== null) {
                    void runAction(
                      () => submit(decision, body),
                      "Could not submit pull request review",
                    )
                  }
                }}
                disabled={submitting || (bodyRequired && body.trim().length === 0)}
              >
                {submitting ? <Loader2 className="animate-spin" /> : <Check />}
                Submit review
              </Button>
            </div>
          </div>
        </AnchoredFloatingPane>
      )}

      {dialog !== "merge" || mergeButtonRef.current === null ? null : (
        <AnchoredFloatingPane
          align="end"
          anchor={mergeButtonRef.current}
          ariaLabel="Merge pull request"
          className="w-[min(30rem,calc(100vw-2rem))]"
          side="bottom"
          sideOffset={8}
          onClose={closeDialog}
        >
          <div className="max-h-[min(38rem,var(--radix-popover-content-available-height))] space-y-4 overflow-y-auto p-4">
            <header className="space-y-1">
              <h2 className="text-sm font-semibold">Merge pull request</h2>
              <p className="text-muted-foreground text-xs leading-5">
                Choose a deterministic merge method. Branch protection and required checks still
                apply.
              </p>
            </header>
            <div className="space-y-2">
              {mergeMethodOptions.map((option) => (
                <div
                  key={option.value}
                  className={cn(
                    "flex items-start gap-3 rounded-lg border p-3",
                    mergeMethod === option.value
                      ? "border-primary bg-primary/5"
                      : "hover:bg-muted/50",
                  )}
                >
                  <input
                    id={`hosted-review-merge-${option.value}`}
                    type="radio"
                    name="merge-method"
                    value={option.value}
                    aria-labelledby={`hosted-review-merge-label-${option.value}`}
                    checked={mergeMethod === option.value}
                    onChange={() => setMergeMethod(option.value)}
                  />
                  <span>
                    <span
                      id={`hosted-review-merge-label-${option.value}`}
                      className="block text-sm font-medium"
                    >
                      {option.label}
                    </span>
                    <span className="text-muted-foreground block text-xs leading-5">
                      {option.description}
                    </span>
                  </span>
                </div>
              ))}
            </div>
            {!bypassAvailable ? null : (
              <div className="border-review-danger-text/30 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
                <input
                  id="hosted-review-bypass-rules"
                  type="checkbox"
                  className="mt-0.5 size-4 accent-destructive"
                  checked={bypassRules}
                  onChange={(event) => setBypassRules(event.target.checked)}
                />
                <span className="space-y-1">
                  <label
                    htmlFor="hosted-review-bypass-rules"
                    className="text-review-danger-text block text-sm font-medium"
                  >
                    Merge without waiting for requirements to be met (bypass rules)
                  </label>
                  <span className="text-muted-foreground block text-xs leading-5">
                    This requires provider permission and merges the displayed head revision
                    immediately.
                  </span>
                </span>
              </div>
            )}
            <ActionError>{error}</ActionError>
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button variant="ghost" onClick={closeDialog} disabled={submitting}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const merge = operations.merge
                  if (merge !== null && mergeSubmissionAllowed) {
                    void runAction(
                      () => merge(mergeMethod, bypassRules),
                      "Could not merge pull request",
                    )
                  }
                }}
                disabled={submitting || !mergeSubmissionAllowed}
                variant={bypassRules ? "destructive" : "default"}
              >
                {submitting ? <Loader2 className="animate-spin" /> : <GitMerge />}
                Merge pull request
              </Button>
            </div>
          </div>
        </AnchoredFloatingPane>
      )}

      <Dialog open={dialog === "close"} onOpenChange={(open) => (open ? undefined : closeDialog())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close pull request?</DialogTitle>
            <DialogDescription>
              This changes the provider state immediately. The pull request can be reopened from the
              provider.
            </DialogDescription>
          </DialogHeader>
          <ActionError>{error}</ActionError>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog} disabled={submitting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const close = operations.close
                if (close !== null) {
                  void runAction(close, "Could not close pull request")
                }
              }}
              disabled={submitting}
            >
              {submitting ? <Loader2 className="animate-spin" /> : null}
              Close pull request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

const reviewDecisionOptions: readonly {
  readonly label: string
  readonly value: HostedReviewSubmissionDecision
}[] = [
  { label: "Approve", value: "approved" },
  { label: "Request changes", value: "changesRequested" },
  { label: "Comment", value: "commented" },
]

const mergeMethodOptions: readonly {
  readonly description: string
  readonly label: string
  readonly value: HostedReviewMergeMethod
}[] = [
  { value: "squash", label: "Squash and merge", description: "Combine all commits into one." },
  { value: "merge", label: "Create a merge commit", description: "Preserve every commit." },
  {
    value: "rebase",
    label: "Rebase and merge",
    description: "Replay commits onto the base branch.",
  },
]

const ActionError = ({ children }: { readonly children: string | null }) =>
  children === null ? null : (
    <p role="alert" className="text-review-danger-text text-sm">
      {children}
    </p>
  )

const mergeStateReason = (mergeState: HostedReviewDetail["mergeState"] | null): string | null => {
  if (mergeState === null) return "Loading merge availability."
  return mergeState.status === "ready" ? null : mergeState.reason
}
