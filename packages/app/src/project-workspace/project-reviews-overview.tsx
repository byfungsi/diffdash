import { workingTreeReviewTarget } from "@diffdash/domain/local-review"
import { type Repo, RepositoryCheckout } from "@diffdash/domain/repository"
import { Match } from "effect"
import { GitBranch, GitPullRequest, RefreshCw } from "lucide-react"
import type { ReactNode } from "react"

import type { SelectedReviewTarget } from "@/review/review-subject"
import { formatError } from "@/shared/errors"
import { Button } from "@/shared/ui/button"
import { ProjectWorkspaceStatePanel } from "@/shared/ui/project-workspace-state-panel"
import { useApplicationCapabilities } from "@/platform/application-capabilities"

import {
  projectReviewsLifecycle,
  type HostedReviewsLifecycle,
  type LocalReviewsLifecycle,
} from "./reviews-lifecycle"

/** Main-canvas project status shown before a local or hosted review is selected. */
export const ProjectReviewsOverview = ({
  hosted,
  local,
  repo,
  onRefreshHosted,
  onRefreshLocal,
  onLinkRepository,
  onSelect,
}: {
  readonly hosted: HostedReviewsLifecycle
  readonly local: LocalReviewsLifecycle
  readonly repo: Repo
  readonly onRefreshHosted: () => void
  readonly onRefreshLocal: () => void
  readonly onLinkRepository: () => void
  readonly onSelect: (target: SelectedReviewTarget) => void
}) => {
  const capabilities = useApplicationCapabilities()
  const lifecycle = projectReviewsLifecycle(local, hosted)
  return (
    <section
      data-project-overview
      data-project-overview-state={lifecycle._tag}
      className="mx-auto flex min-h-full max-w-3xl flex-col justify-center gap-4 px-6 py-10"
    >
      <header>
        <p className="text-muted-foreground text-xs font-medium">Project</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{repo.displayIdentity}</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          {capabilities.localProjects
            ? "Local changes and hosted pull requests stay together in this workspace."
            : "Hosted pull requests and browser-local review progress stay together in this workspace."}
        </p>
      </header>
      {Match.valueTags(lifecycle, {
        loading: () => (
          <ProjectWorkspaceStatePanel
            announcement="loading"
            description="Checking local changes and hosted pull requests."
            title="Loading review sources"
            tone="neutral"
          />
        ),
        ready: () => null,
        empty: () => (
          <ProjectWorkspaceStatePanel
            description="The working tree is clean and there are no open pull requests."
            title="Nothing to review"
            tone="neutral"
          />
        ),
        unavailable: ({ reason }) => (
          <ProjectWorkspaceStatePanel
            description={reason}
            title="Review sources unavailable"
            tone="warning"
          />
        ),
        failure: ({ error }) => (
          <ProjectWorkspaceStatePanel
            announcement="alert"
            description={formatError(error, "Review sources could not be loaded")}
            title="Review sources could not be loaded"
            tone="danger"
          />
        ),
        stale: ({ reason }) => (
          <ProjectWorkspaceStatePanel
            description={reason}
            title="Review status may be stale"
            tone="warning"
          />
        ),
        invalid: ({ reason }) => (
          <ProjectWorkspaceStatePanel
            announcement="alert"
            description={reason}
            title="Project review state invalid"
            tone="danger"
          />
        ),
        degraded: ({ issues }) => (
          <ProjectWorkspaceStatePanel
            description={issues.join(" ")}
            title="Some review sources are unavailable"
            tone="warning"
          />
        ),
      })}
      <div className={`grid gap-3 ${capabilities.localProjects ? "sm:grid-cols-2" : ""}`}>
        {capabilities.localProjects ? (
          <OverviewCard icon={<GitBranch className="size-4" />} title="Working tree">
            {renderLocalOverview(repo, local, onRefreshLocal, onLinkRepository, onSelect)}
          </OverviewCard>
        ) : null}
        <OverviewCard icon={<GitPullRequest className="size-4" />} title="Pull requests">
          {renderHostedOverview(hosted, onRefreshHosted)}
        </OverviewCard>
      </div>
    </section>
  )
}

const OverviewCard = ({
  children,
  icon,
  title,
}: {
  readonly children: ReactNode
  readonly icon: ReactNode
  readonly title: string
}) => (
  <article className="bg-card border-border rounded-xl border p-4 shadow-xs">
    <h2 className="flex items-center gap-2 text-sm font-semibold">
      <span className="text-primary">{icon}</span>
      {title}
    </h2>
    <div className="mt-3">{children}</div>
  </article>
)

const renderLocalOverview = (
  repo: Repo,
  lifecycle: LocalReviewsLifecycle,
  onRefresh: () => void,
  onLinkRepository: () => void,
  onSelect: (target: SelectedReviewTarget) => void,
) => {
  return RepositoryCheckout.match(repo.checkout, {
    RemoteOnly: () => (
      <OverviewStatus
        actions={
          <Button size="sm" variant="outline" onClick={onLinkRepository}>
            Link folder
          </Button>
        }
        text="No local checkout linked."
      />
    ),
    LinkedCheckout: ({ path }) => {
      const openAction = (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onSelect({ kind: "localDiff", target: workingTreeReviewTarget(path) })}
        >
          Open working tree
        </Button>
      )
      return Match.valueTags(lifecycle, {
        loading: () => <OverviewStatus text="Checking local changes..." actions={null} />,
        ready: ({ data }) => (
          <OverviewStatus
            actions={openAction}
            text={`${data.fileCount} changed file${data.fileCount === 1 ? "" : "s"}.`}
          />
        ),
        empty: () => <OverviewStatus actions={openAction} text="Working tree clean." />,
        unavailable: ({ reason }) => <OverviewStatus actions={null} text={reason} />,
        failure: ({ error }) => (
          <OverviewStatus
            actions={<RetryButton onClick={onRefresh} />}
            text={formatError(error, "Could not inspect the working tree")}
          />
        ),
        stale: ({ data, reason }) => (
          <OverviewStatus
            actions={openAction}
            text={`${data.fileCount} changed files. ${reason}`}
          />
        ),
        invalid: ({ reason }) => <OverviewStatus actions={null} text={reason} />,
        degraded: ({ data, issues }) => (
          <OverviewStatus
            actions={openAction}
            text={`${data.fileCount} changed files. ${issues.join(" ")}`}
          />
        ),
      })
    },
  })
}

const renderHostedOverview = (lifecycle: HostedReviewsLifecycle, onRefresh: () => void) =>
  Match.valueTags(lifecycle, {
    loading: () => <OverviewStatus actions={null} text="Loading open pull requests..." />,
    ready: ({ data }) => (
      <OverviewStatus
        actions={<RetryButton label="Refresh" onClick={onRefresh} />}
        text={`${data.length} open pull request${data.length === 1 ? "" : "s"}.`}
      />
    ),
    empty: () => (
      <OverviewStatus
        actions={<RetryButton label="Refresh" onClick={onRefresh} />}
        text="No open pull requests."
      />
    ),
    unavailable: ({ reason }) => <OverviewStatus actions={null} text={reason} />,
    failure: ({ error }) => (
      <OverviewStatus
        actions={<RetryButton onClick={onRefresh} />}
        text={formatError(error, "Could not load pull requests")}
      />
    ),
    stale: ({ data, reason }) => (
      <OverviewStatus
        actions={<RetryButton onClick={onRefresh} />}
        text={`${data.length} open. ${reason}`}
      />
    ),
    invalid: ({ reason }) => <OverviewStatus actions={null} text={reason} />,
    degraded: ({ data, issues }) => (
      <OverviewStatus
        actions={<RetryButton onClick={onRefresh} />}
        text={`${data.length} open. ${issues.join(" ")}`}
      />
    ),
  })

const OverviewStatus = ({
  actions,
  text,
}: {
  readonly actions: ReactNode
  readonly text: string
}) => (
  <div className="space-y-3">
    <p className="text-muted-foreground text-xs leading-5">{text}</p>
    {actions}
  </div>
)

const RetryButton = ({
  label = "Retry",
  onClick,
}: {
  readonly label?: string
  readonly onClick: () => void
}) => (
  <Button size="sm" variant="outline" onClick={onClick}>
    <RefreshCw className="size-3.5" />
    {label}
  </Button>
)
