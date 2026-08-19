import type { HostedReviewSummary } from "@diffdash/domain/git-provider"
import { workingTreeReviewTarget } from "@diffdash/domain/local-review"
import type { Repo } from "@diffdash/domain/repository"
import { Match } from "effect"
import { AlertTriangle, GitBranch, GitPullRequest, Loader2, RefreshCw } from "lucide-react"
import type { ReactNode } from "react"

import { PullRequestStateBadge } from "@/review/pull-request-state-badge"
import type { SelectedReviewTarget } from "@/review/review-subject"
import { formatError } from "@/shared/errors"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { ProjectWorkspaceStatePanel } from "@/shared/ui/project-workspace-state-panel"

import {
  projectReviewsLifecycle,
  type HostedReviewsLifecycle,
  type LocalReviewsLifecycle,
} from "./reviews-lifecycle"

/** Reviews context pane with independent local and hosted source states. */
export const ReviewsPane = ({
  hosted,
  local,
  repo,
  onRefreshHosted,
  onRefreshLocal,
  onSelect,
}: {
  readonly hosted: HostedReviewsLifecycle
  readonly local: LocalReviewsLifecycle
  readonly repo: Repo
  readonly onRefreshHosted: () => void
  readonly onRefreshLocal: () => void
  readonly onSelect: (target: SelectedReviewTarget) => void
}) => {
  const lifecycle = projectReviewsLifecycle(local, hosted)
  const sources = (
    <ReviewsSources
      hosted={hosted}
      local={local}
      repo={repo}
      onRefreshLocal={onRefreshLocal}
      onSelect={onSelect}
    />
  )
  const content = Match.valueTags(lifecycle, {
    loading: () => sources,
    ready: () => sources,
    empty: () => (
      <>
        <ProjectWorkspaceStatePanel
          description="The working tree is clean and there are no open pull requests."
          title="Nothing to review"
          tone="neutral"
        />
        {sources}
      </>
    ),
    unavailable: ({ reason }) => (
      <>
        <ProjectWorkspaceStatePanel
          description={reason}
          title="Reviews unavailable"
          tone="warning"
        />
        {sources}
      </>
    ),
    failure: ({ error }) => (
      <>
        <ProjectWorkspaceStatePanel
          announcement="alert"
          description={formatError(error, "Review sources could not be loaded")}
          title="Reviews could not be loaded"
          tone="danger"
        />
        {sources}
      </>
    ),
    stale: ({ reason }) => (
      <>
        <ProjectWorkspaceStatePanel
          description={reason}
          title="Reviews may be stale"
          tone="warning"
        />
        {sources}
      </>
    ),
    invalid: ({ reason }) => (
      <ProjectWorkspaceStatePanel
        announcement="alert"
        description={reason}
        title="Review state invalid"
        tone="danger"
      />
    ),
    degraded: ({ issues }) => (
      <>
        <ProjectWorkspaceStatePanel
          description={issues.join(" ")}
          title="Some review sources are unavailable"
          tone="warning"
        />
        {sources}
      </>
    ),
  })

  return (
    <aside
      data-project-reviews-pane
      data-project-reviews-state={lifecycle._tag}
      className="bg-review-sidebar text-review-sidebar-fg relative z-20 flex h-full min-h-0 min-w-0 flex-col"
    >
      <header className="border-review-sidebar-divider flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <h2 className="text-caption min-w-0 flex-1 truncate font-semibold tracking-wide uppercase">
          Reviews
        </h2>
        {repo.hostedLocator === null ? null : (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh pull requests"
            className="text-review-sidebar-muted hover:text-review-sidebar-fg"
            onClick={onRefreshHosted}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">{content}</div>
    </aside>
  )
}

const ReviewsSources = ({
  hosted,
  local,
  repo,
  onRefreshLocal,
  onSelect,
}: {
  readonly hosted: HostedReviewsLifecycle
  readonly local: LocalReviewsLifecycle
  readonly repo: Repo
  readonly onRefreshLocal: () => void
  readonly onSelect: (target: SelectedReviewTarget) => void
}) => (
  <>
    <ReviewSourceSection title="Local changes">
      {renderLocalLifecycle(repo, local, onRefreshLocal, onSelect)}
    </ReviewSourceSection>
    <ReviewSourceSection title="Open pull requests">
      {renderHostedLifecycle(hosted, onSelect)}
    </ReviewSourceSection>
  </>
)

const ReviewSourceSection = ({
  title,
  children,
}: {
  readonly title: string
  readonly children: ReactNode
}) => (
  <section className="space-y-2">
    <h3 className="text-caption text-review-sidebar-muted font-semibold tracking-wide uppercase">
      {title}
    </h3>
    {children}
  </section>
)

const renderLocalLifecycle = (
  repo: Repo,
  lifecycle: LocalReviewsLifecycle,
  onRefresh: () => void,
  onSelect: (target: SelectedReviewTarget) => void,
) =>
  Match.valueTags(lifecycle, {
    loading: () => localReviewContent(repo, "Checking working tree...", true, null, null, onSelect),
    ready: ({ data, refresh }) =>
      localReviewContent(
        repo,
        data.fileCount === 0
          ? "Clean working tree"
          : `${data.fileCount} changed file${data.fileCount === 1 ? "" : "s"}`,
        refresh === "refreshing",
        null,
        null,
        onSelect,
      ),
    empty: ({ refresh }) =>
      localReviewContent(
        repo,
        "Clean working tree",
        refresh === "refreshing",
        null,
        null,
        onSelect,
      ),
    unavailable: ({ reason }) => <SourceMessage>{reason}</SourceMessage>,
    failure: ({ error }) =>
      localReviewContent(
        repo,
        "Working tree status unavailable",
        false,
        formatError(error, "Could not load working tree"),
        onRefresh,
        onSelect,
      ),
    stale: ({ data, reason, refresh }) =>
      localReviewContent(
        repo,
        `${data.fileCount} changed file${data.fileCount === 1 ? "" : "s"}`,
        refresh === "refreshing",
        reason,
        onRefresh,
        onSelect,
      ),
    invalid: ({ reason }) =>
      localReviewContent(repo, "Working tree status invalid", false, reason, null, onSelect),
    degraded: ({ data, issues, refresh }) =>
      localReviewContent(
        repo,
        `${data.fileCount} changed file${data.fileCount === 1 ? "" : "s"}`,
        refresh === "refreshing",
        issues.join(" "),
        onRefresh,
        onSelect,
      ),
  })

const localReviewContent = (
  repo: Repo,
  status: string,
  loading: boolean,
  issue: string | null,
  onRetry: (() => void) | null,
  onSelect: (target: SelectedReviewTarget) => void,
) => {
  if (repo.localPath === null) return <SourceMessage>No local checkout linked.</SourceMessage>
  const target = workingTreeReviewTarget(repo.localPath)
  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-label="Open working tree review"
        className="border-review-sidebar-divider bg-review-sidebar-control hover:bg-review-sidebar-control-hover flex w-full items-center gap-2 rounded-lg border p-2.5 text-left transition-colors"
        onClick={() => onSelect({ kind: "localDiff", target })}
      >
        {loading ? (
          <Loader2 className="text-review-sidebar-muted size-4 shrink-0 animate-spin" />
        ) : (
          <GitBranch className="text-primary size-4 shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold">Working tree</span>
          <span className="text-review-sidebar-muted mt-0.5 block truncate text-xs">{status}</span>
        </span>
      </button>
      {issue === null ? null : (
        <div className="space-y-2">
          <p role="alert" className="text-caption text-risk-review flex gap-1.5 leading-4">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            {issue}
          </p>
          {onRetry === null ? null : (
            <Button size="xs" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

const renderHostedLifecycle = (
  lifecycle: HostedReviewsLifecycle,
  onSelect: (target: SelectedReviewTarget) => void,
) =>
  Match.valueTags(lifecycle, {
    loading: () => (
      <ProjectWorkspaceStatePanel
        announcement="loading"
        description="Fetching open pull requests from the hosted provider."
        title="Loading pull requests"
        tone="neutral"
      />
    ),
    ready: ({ data, refresh }) => (
      <HostedReviewList reviews={data} refreshing={refresh === "refreshing"} onSelect={onSelect} />
    ),
    empty: ({ refresh }) => (
      <SourceMessage>
        {refresh === "refreshing" ? "Refreshing pull requests..." : "No open pull requests."}
      </SourceMessage>
    ),
    unavailable: ({ reason }) => <SourceMessage>{reason}</SourceMessage>,
    failure: ({ error }) => (
      <ProjectWorkspaceStatePanel
        announcement="alert"
        description={formatError(error, "Could not load pull requests")}
        title="Hosted reviews unavailable"
        tone="danger"
      />
    ),
    stale: ({ data, reason, refresh }) => (
      <div className="space-y-2">
        <SourceWarning>{reason}</SourceWarning>
        <HostedReviewList
          reviews={data}
          refreshing={refresh === "refreshing"}
          onSelect={onSelect}
        />
      </div>
    ),
    invalid: ({ reason }) => (
      <ProjectWorkspaceStatePanel
        announcement="alert"
        description={reason}
        title="Hosted review state invalid"
        tone="danger"
      />
    ),
    degraded: ({ data, issues, refresh }) => (
      <div className="space-y-2">
        <SourceWarning>{issues.join(" ")}</SourceWarning>
        <HostedReviewList
          reviews={data}
          refreshing={refresh === "refreshing"}
          onSelect={onSelect}
        />
      </div>
    ),
  })

const HostedReviewList = ({
  reviews,
  refreshing,
  onSelect,
}: {
  readonly reviews: readonly HostedReviewSummary[]
  readonly refreshing: boolean
  readonly onSelect: (target: SelectedReviewTarget) => void
}) => (
  <div className="space-y-2" aria-busy={refreshing || undefined}>
    {refreshing ? <SourceMessage>Refreshing pull requests...</SourceMessage> : null}
    {reviews.map((review) => (
      <button
        key={`${review.locator.repository.providerId}:${review.locator.repository.namespace}/${review.locator.repository.name}#${review.locator.number}`}
        type="button"
        aria-label={`Open review #${review.locator.number}: ${review.title}`}
        className="border-review-sidebar-divider bg-review-sidebar-control hover:bg-review-sidebar-control-hover w-full rounded-lg border p-2.5 text-left transition-colors"
        onClick={() => onSelect({ kind: "hosted", review: review.locator })}
      >
        <span className="flex items-start gap-2">
          <GitPullRequest className="text-primary mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-review-sidebar-muted text-xs">#{review.locator.number}</span>
              <PullRequestStateBadge
                className="text-caption"
                isDraft={review.draft}
                state={review.state}
              />
            </span>
            <span className="mt-1 block line-clamp-2 text-xs font-medium">{review.title}</span>
            <Badge variant="secondary" className="text-caption mt-2 max-w-full truncate">
              @{review.author.username}
            </Badge>
          </span>
        </span>
      </button>
    ))}
  </div>
)

const SourceMessage = ({ children }: { readonly children: ReactNode }) => (
  <p className="text-review-sidebar-muted border-review-sidebar-divider rounded-lg border border-dashed p-3 text-xs leading-5">
    {children}
  </p>
)

const SourceWarning = ({ children }: { readonly children: ReactNode }) => (
  <p role="alert" className="text-caption text-risk-review flex gap-1.5 leading-4">
    <AlertTriangle className="mt-0.5 size-3 shrink-0" />
    {children}
  </p>
)
