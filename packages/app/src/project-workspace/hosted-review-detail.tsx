import type {
  ChangedFile,
  HostedReviewCheck,
  HostedReviewComment,
  HostedReviewDetail as HostedReviewDetailModel,
  HostedReviewSummary,
  ReviewCommit,
} from "@diffdash/domain/git-provider"
import {
  ExternalLink,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  MessageSquare,
} from "lucide-react"
import type { ReactNode } from "react"

import { runRendererPromise, useDesktopRuntime } from "@/platform/renderer-runtime"
import { PullRequestStateBadge } from "@/review/pull-request-state-badge"
import { formatTimestamp } from "@/shared/timestamp"
import { Button } from "@/shared/ui/button"
import { MarkdownContent } from "@/shared/ui/markdown-content"
import { ProjectWorkspaceStatePanel } from "@/shared/ui/project-workspace-state-panel"
import { HostedReviewActions, type HostedReviewActionOperations } from "./hosted-review-actions"
import { HostedReviewChecks } from "./hosted-review-checks"
import { HostedReviewMergeStatus } from "./hosted-review-merge-status"

/** Main project view for a selected hosted pull request before its diff is opened. */
export const HostedReviewDetail = ({
  actions,
  checks,
  checksError,
  checksLoading,
  checksSupported,
  commits,
  comments,
  error,
  files,
  loading,
  mergeState,
  onOpenDiff,
  onRetry,
  onRefreshChecks,
  onActionCompleted,
  reviewAbbreviation,
  providerName,
  summary,
}: {
  readonly actions: HostedReviewActionOperations
  readonly checks: readonly HostedReviewCheck[]
  readonly checksError: string | null
  readonly checksLoading: boolean
  readonly checksSupported: boolean
  readonly commits: readonly ReviewCommit[] | null
  readonly comments: readonly HostedReviewComment[] | null
  readonly error: string | null
  readonly files: readonly ChangedFile[] | null
  readonly loading: boolean
  readonly mergeState: HostedReviewDetailModel["mergeState"] | null
  readonly onOpenDiff: () => void
  readonly onRetry: () => void
  readonly onRefreshChecks: () => void
  readonly onActionCompleted: () => void
  readonly reviewAbbreviation: string
  readonly providerName: string
  readonly summary: HostedReviewSummary | null
}) => {
  const desktop = useDesktopRuntime()

  if (summary === null) {
    return (
      <ProjectWorkspaceStatePanel
        announcement={error === null ? "loading" : "alert"}
        actions={error === null ? null : <Button onClick={onRetry}>Retry</Button>}
        description={error ?? "Fetching pull request details."}
        title={error === null ? "Loading pull request" : "Pull request unavailable"}
        tone={error === null ? "neutral" : "danger"}
      />
    )
  }

  return (
    <section
      className="mx-auto min-h-full w-full max-w-review-diff px-5 py-8 lg:px-8 lg:py-10"
      data-hosted-review-detail
    >
      <span className="sr-only">
        Opened {reviewAbbreviation} #{summary.locator.number}: {summary.title}
      </span>
      <header className="border-border-subtle border-b pb-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <PullRequestStateBadge isDraft={summary.draft} state={summary.state} />
              <span className="text-muted-foreground text-sm">#{summary.locator.number}</span>
            </div>
            <h1 className="max-w-4xl text-2xl leading-tight font-semibold tracking-tight lg:text-3xl">
              {summary.title}
            </h1>
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="text-foreground font-medium">
                {summary.author.displayName ?? `@${summary.author.username}`}
              </span>
              <span>wants to merge</span>
              <BranchBadge value={summary.head.name} />
              <span>into</span>
              <BranchBadge value={summary.base.name} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <HostedReviewActions
              mergeState={mergeState}
              operations={actions}
              onCompleted={onActionCompleted}
            />
            <Button
              variant="outline"
              aria-label="Open pull request in provider"
              onClick={() =>
                void runRendererPromise(desktop.openExternalUrl(summary.url)).catch(() => undefined)
              }
            >
              <ExternalLink />
              Provider
            </Button>
            <Button onClick={onOpenDiff}>
              <FileDiff />
              Open diff
            </Button>
          </div>
        </div>
      </header>

      <div className="grid gap-10 pt-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <main className="min-w-0 space-y-10">
          {error !== null ? (
            <ProjectWorkspaceStatePanel
              announcement="alert"
              actions={<Button onClick={onRetry}>Retry</Button>}
              description={error}
              title="Pull request details could not be refreshed"
              tone="danger"
            />
          ) : null}

          <OverviewSection title="Description">
            {summary.body === null || summary.body.trim().length === 0 ? (
              <p className="text-muted-foreground text-sm">No description provided.</p>
            ) : (
              <MarkdownContent>{summary.body}</MarkdownContent>
            )}
          </OverviewSection>

          <OverviewSection
            title="Activity"
            icon={<MessageSquare className="text-muted-foreground size-4" />}
          >
            {loading ? (
              <LoadingLine label="Loading conversation..." />
            ) : comments === null || comments.length === 0 ? (
              <div className="border-border-subtle text-muted-foreground rounded-lg border border-dashed px-4 py-8 text-center text-sm">
                No comments yet.
              </div>
            ) : (
              <div className="space-y-5">
                {comments.map((comment) => (
                  <article
                    key={`${comment.url ?? comment.createdAt ?? "comment"}:${comment.author.username}:${comment.body}`}
                    className="border-border-subtle overflow-hidden rounded-lg border"
                  >
                    <header className="bg-muted/45 flex items-center justify-between gap-3 border-b px-4 py-2.5 text-xs">
                      <span className="font-medium">@{comment.author.username}</span>
                      <span className="text-muted-foreground">
                        {comment.createdAt === null
                          ? ""
                          : formatTimestamp(comment.createdAt, comment.createdAt)}
                      </span>
                    </header>
                    <MarkdownContent className="px-4 py-4">{comment.body}</MarkdownContent>
                  </article>
                ))}
              </div>
            )}
          </OverviewSection>
        </main>

        <aside className="space-y-6 lg:border-l lg:pl-6" aria-label="Pull request summary">
          <HostedReviewMergeStatus
            mergeState={mergeState}
            providerName={providerName}
            reviewUrl={summary.url}
            updateBranch={actions.updateBranch}
            onCompleted={onActionCompleted}
          />
          {checksSupported ? (
            <HostedReviewChecks
              checks={checks}
              error={checksError}
              loading={checksLoading}
              providerName={providerName}
              onRefresh={onRefreshChecks}
            />
          ) : null}
          <StatusRailSection title="Review status">
            <p className="text-sm font-medium capitalize">
              {summary.decision === "none" ? "No decision" : decisionLabel(summary.decision)}
            </p>
          </StatusRailSection>
          <StatusRailSection title="Changes">
            <div className="space-y-3 text-sm">
              <StatusMetric icon={<FileDiff />}>
                {loading ? (
                  "Loading files..."
                ) : files === null ? (
                  "Available in diff"
                ) : (
                  <>
                    {files.length} file{files.length === 1 ? "" : "s"} {fileChangeSummary(files)}
                  </>
                )}
              </StatusMetric>
              <StatusMetric icon={<GitCommitHorizontal />}>
                {loading
                  ? "Loading commits..."
                  : commits === null
                    ? "Commits available in diff"
                    : `${commits.length} commit${commits.length === 1 ? "" : "s"}`}
              </StatusMetric>
            </div>
          </StatusRailSection>
          <StatusRailSection title="Branches">
            <dl className="space-y-3 text-xs">
              <BranchDefinition label="Head" value={summary.head.name} />
              <BranchDefinition label="Base" value={summary.base.name} />
            </dl>
          </StatusRailSection>
          {summary.updatedAt === null ? null : (
            <StatusRailSection title="Last updated">
              <p className="text-muted-foreground text-sm">
                {formatTimestamp(summary.updatedAt, summary.updatedAt)}
              </p>
            </StatusRailSection>
          )}
        </aside>
      </div>
    </section>
  )
}

const OverviewSection = ({
  children,
  icon,
  title,
}: {
  readonly children: ReactNode
  readonly icon?: ReactNode
  readonly title: string
}) => (
  <section className="space-y-4">
    <div className="flex items-center gap-2 border-b pb-3">
      {icon}
      <h2 className="text-base font-semibold">{title}</h2>
    </div>
    {children}
  </section>
)

const StatusRailSection = ({
  children,
  title,
}: {
  readonly children: ReactNode
  readonly title: string
}) => (
  <section className="border-border-subtle space-y-2 border-b pb-5 last:border-0">
    <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">{title}</h2>
    {children}
  </section>
)

const StatusMetric = ({
  children,
  icon,
}: {
  readonly children: ReactNode
  readonly icon: ReactNode
}) => (
  <div className="text-muted-foreground flex items-center gap-2 [&_svg]:size-3.5">
    {icon}
    {children}
  </div>
)

const BranchBadge = ({ value }: { readonly value: string }) => (
  <span className="bg-muted text-foreground inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 font-mono text-xs">
    <GitBranch className="size-3" />
    <span className="truncate">{value}</span>
  </span>
)

const BranchDefinition = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <div className="space-y-1">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="bg-muted truncate rounded-md px-2 py-1.5 font-mono">{value}</dd>
  </div>
)

const LoadingLine = ({ label }: { readonly label: string }) => (
  <p className="text-muted-foreground flex items-center gap-2 text-sm">
    <Loader2 className="size-3.5 animate-spin" />
    {label}
  </p>
)

const fileChangeSummary = (files: readonly ChangedFile[]) => {
  const additions = files.reduce((total, file) => total + file.additions, 0)
  const deletions = files.reduce((total, file) => total + file.deletions, 0)
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-review-success-text">+{additions}</span>
      <span className="text-review-danger-text">-{deletions}</span>
    </span>
  )
}

const decisionLabel = (decision: HostedReviewSummary["decision"]): string => {
  if (decision === "approved") return "Approved"
  if (decision === "changesRequested") return "Changes requested"
  if (decision === "commented") return "Commented"
  return "No decision"
}
