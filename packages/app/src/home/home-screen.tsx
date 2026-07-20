import type {
  GitProviderDescriptor,
  HostedRepository,
  HostedReviewSummary,
} from "@diffdash/domain/git-provider"
import type { Repo, RepositorySearchScope } from "@diffdash/domain/repository"
import type { AppPrerequisites } from "@diffdash/protocol/prerequisites"
import {
  ArrowRight,
  Cloud,
  GitBranch,
  Laptop,
  Loader2,
  Search,
  Sparkles,
  Star,
  UserRound,
} from "lucide-react"
import { SetupBanner, missingPrerequisiteRows } from "@/onboarding/onboarding-screen"
import type { HostedReviewTarget } from "@/review/review-subject"
import { PullRequestStateBadge } from "@/review/pull-request-state-badge"
import { formatTimestamp } from "@/shared/timestamp"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card"
import { EmptyState } from "@/shared/ui/empty-state"
import { Input } from "@/shared/ui/input"
import { Surface } from "@/shared/ui/surface"

/** Renderer-only recent review entry retained by Home navigation. */
export type RecentReviewEntry = {
  readonly key: string
  readonly lastReviewedAt: string
  readonly repoName: string
  readonly repoOwner: string
  readonly sourceRepoId: string | null
  readonly target: HostedReviewTarget
  readonly title: string
}

/** Presentational state for the Home feature. */
type HomeScreenProps = {
  readonly activeProviderId: string | null
  readonly bookmarkedRepos: readonly Repo[]
  readonly diagnostics: AppPrerequisites
  readonly hasQuery: boolean
  readonly isLoadingDiagnostics: boolean
  readonly isLoadingPullRequests: boolean
  readonly isLoadingReviewRequests: boolean
  readonly isSearching: boolean
  readonly localResults: readonly Repo[]
  readonly providers: readonly GitProviderDescriptor[]
  readonly pullRequests: readonly HostedReviewSummary[]
  readonly query: string
  readonly recentReviews: readonly RecentReviewEntry[]
  readonly remoteResults: readonly HostedRepository[]
  readonly repoPrCounts: Readonly<Record<string, number>>
  readonly reviewRequests: readonly HostedReviewSummary[]
  readonly reviewRequestsStatus: string
  readonly searchError: string | null
  readonly searchScopes: readonly RepositorySearchScope[]
  readonly selectedProvider: GitProviderDescriptor | null
  readonly selectedRepo: Repo | null
  readonly selectedRepoStatus: string
  readonly selectedSearchScope: string | null
  readonly setupStatus: string | null
  readonly onBookmark: (repo: HostedRepository) => void
  readonly onInstallDiffDashCli: () => void
  readonly onOpenDocs: (url: string) => void
  readonly onOpenRecentReview: (review: RecentReviewEntry) => void
  readonly onOpenReview: (pullRequest: HostedReviewSummary) => void
  readonly onOpenReviewRequest: (pullRequest: HostedReviewSummary) => void
  readonly onRecheck: () => void
  readonly onSelectProvider: (providerId: string) => void
  readonly onSelectRepo: (repo: Repo) => void
  readonly onSelectRemote: (repo: HostedRepository) => void
  readonly onSelectScope: (scope: string) => void
  readonly onShowAll: () => void
  readonly onToggleBookmark: (repo: Repo) => void
  readonly onQueryChange: (query: string) => void
}

/** Home repository search, bookmarks, review requests, and preview composition. */
export const HomeScreen = ({
  activeProviderId,
  bookmarkedRepos,
  diagnostics,
  hasQuery,
  isLoadingDiagnostics,
  isLoadingPullRequests,
  isLoadingReviewRequests,
  isSearching,
  localResults,
  providers,
  pullRequests,
  query,
  recentReviews,
  remoteResults,
  repoPrCounts,
  reviewRequests,
  reviewRequestsStatus,
  searchError,
  searchScopes,
  selectedProvider,
  selectedRepo,
  selectedRepoStatus,
  selectedSearchScope,
  setupStatus,
  onBookmark,
  onInstallDiffDashCli,
  onOpenDocs,
  onOpenRecentReview,
  onOpenReview,
  onOpenReviewRequest,
  onQueryChange,
  onRecheck,
  onSelectProvider,
  onSelectRepo,
  onSelectRemote,
  onSelectScope,
  onShowAll,
  onToggleBookmark,
}: HomeScreenProps) => {
  const previewPullRequests = pullRequests.slice(0, 3)
  return (
    <section className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-7 text-sm">
      <header className="space-y-3 pt-3">
        <Badge variant="secondary" className="text-caption w-fit gap-1.5">
          <Sparkles className="size-3" />
          {import.meta.env.VITE_APP_VERSION}
        </Badge>
        <div className="space-y-2">
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight">DiffDash</h1>
          <p className="text-muted-foreground max-w-3xl text-sm">
            Find a repo, open a {selectedProvider?.terminology.reviewSingular ?? "review"}, and jump
            into focused review without leaving the desktop.
          </p>
        </div>
      </header>

      {!isLoadingDiagnostics && missingPrerequisiteRows(diagnostics).length > 0 ? (
        <SetupBanner
          diagnostics={diagnostics}
          status={setupStatus}
          onInstallDiffDashCli={onInstallDiffDashCli}
          onOpenDocs={onOpenDocs}
          onRecheck={onRecheck}
        />
      ) : null}

      <div className="relative z-20">
        <div className="relative h-10">
          <Surface
            active={hasQuery}
            variant="floatingSearch"
            className="absolute inset-x-0 top-0 z-30"
          >
            <div className="relative h-10">
              <Search className="text-muted-foreground absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
              <Input
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                className="h-10 border-0 bg-transparent pr-9 pl-9 text-sm shadow-none focus-visible:border-0 focus-visible:bg-transparent focus-visible:ring-0"
                placeholder="Search bookmarked and accessible repositories"
              />
              {isSearching ? (
                <Loader2 className="text-muted-foreground absolute top-1/2 right-3 size-3.5 -translate-y-1/2 animate-spin" />
              ) : null}
            </div>
            {providers.length > 1 ? (
              <div className="border-t px-3 py-2">
                <label className="text-muted-foreground flex items-center gap-2 text-xs">
                  Provider
                  <select
                    aria-label="Hosted provider"
                    value={activeProviderId ?? ""}
                    className="bg-background rounded-md border px-2 py-1"
                    onChange={(event) => onSelectProvider(event.currentTarget.value)}
                  >
                    {providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}
            {hasQuery ? (
              <SearchResults
                localResults={localResults}
                remoteResults={remoteResults}
                scopes={searchScopes}
                selectedScope={selectedSearchScope}
                isSearching={isSearching}
                error={searchError}
                onBookmark={onBookmark}
                onSelectLocal={onSelectRepo}
                onSelectRemote={onSelectRemote}
                onSelectScope={onSelectScope}
              />
            ) : null}
          </Surface>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Bookmarked Repos</CardTitle>
              <CardDescription>Starred repos stay here for fast PR review.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              {bookmarkedRepos.length === 0 ? (
                <EmptyState className="md:col-span-2">
                  Search for a repository to create your first bookmark.
                </EmptyState>
              ) : (
                bookmarkedRepos.map((repo) => (
                  <RepoCard
                    key={repo.id}
                    prCount={repoPrCounts[repo.id]}
                    repo={repo}
                    loading={selectedRepo?.id === repo.id && isLoadingPullRequests}
                    selected={selectedRepo?.id === repo.id}
                    onSelect={() => onSelectRepo(repo)}
                    onToggleBookmark={() => onToggleBookmark(repo)}
                  />
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent Review Requests</CardTitle>
              <CardDescription>{reviewRequestsStatus}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {isLoadingReviewRequests ? <EmptyState>Loading review requests...</EmptyState> : null}
              {!isLoadingReviewRequests && reviewRequests.length === 0 ? (
                <EmptyState>{reviewRequestsStatus}</EmptyState>
              ) : null}
              {reviewRequests.map((pullRequest) => (
                <ReviewRequestRow
                  key={`${pullRequest.locator.repository.providerId}:${pullRequest.locator.repository.namespace}/${pullRequest.locator.repository.name}#${pullRequest.locator.number}`}
                  pullRequest={pullRequest}
                  onOpen={() => onOpenReviewRequest(pullRequest)}
                />
              ))}
            </CardContent>
          </Card>

          {recentReviews.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Recently Reviewed</CardTitle>
                <CardDescription>Reopen the review sessions touched most recently.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {recentReviews.map((review) => (
                  <RecentReviewRow
                    key={review.key}
                    review={review}
                    onOpen={() => onOpenRecentReview(review)}
                  />
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>
              {selectedRepo ? `${selectedRepo.owner}/${selectedRepo.name}` : "PR Preview"}
            </CardTitle>
            <CardDescription>
              {selectedRepo ? selectedRepoStatus : "Select a repo to preview its first 3 open PRs."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoadingPullRequests ? (
              <EmptyState>Loading open PRs...</EmptyState>
            ) : selectedRepo === null ? (
              <EmptyState>No repo selected.</EmptyState>
            ) : pullRequests.length === 0 ? (
              <EmptyState>No open PRs found for this repo.</EmptyState>
            ) : (
              <>
                {previewPullRequests.map((pullRequest) => (
                  <PullRequestRow
                    key={pullRequest.locator.number}
                    pullRequest={pullRequest}
                    onOpen={() => onOpenReview(pullRequest)}
                  />
                ))}
                {pullRequests.length > 3 ? (
                  <Button variant="outline" className="w-full rounded-xl" onClick={onShowAll}>
                    Show {pullRequests.length - 3} more
                    <ArrowRight className="size-3.5" />
                  </Button>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  )
}

const SearchResults = ({
  error,
  isSearching,
  localResults,
  remoteResults,
  scopes,
  selectedScope,
  onBookmark,
  onSelectLocal,
  onSelectRemote,
  onSelectScope,
}: {
  readonly error: string | null
  readonly isSearching: boolean
  readonly localResults: readonly Repo[]
  readonly remoteResults: readonly HostedRepository[]
  readonly scopes: readonly RepositorySearchScope[]
  readonly selectedScope: string | null
  readonly onBookmark: (repo: HostedRepository) => void
  readonly onSelectLocal: (repo: Repo) => void
  readonly onSelectRemote: (repo: HostedRepository) => void
  readonly onSelectScope: (scope: string) => void
}) => {
  const hasResults = localResults.length > 0 || remoteResults.length > 0
  return (
    <div className="bg-search-surface max-h-search-results overflow-y-auto p-3 pt-0">
      <div className="flex flex-wrap gap-1.5">
        {scopes.map((scope) => {
          const isSelected = selectedScope === scope.login
          return (
            <button
              key={`${scope.kind}:${scope.login}`}
              type="button"
              aria-pressed={isSelected}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                isSelected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-muted text-muted-foreground hover:border-ring/30 hover:bg-secondary"
              }`}
              onClick={() => onSelectScope(scope.login)}
            >
              {scope.login}
            </button>
          )
        })}
      </div>
      <div className="mt-4 space-y-1.5">
        {error !== null ? (
          <div
            role="alert"
            className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border p-3 text-xs"
          >
            {error}
          </div>
        ) : null}
        {!hasResults && !isSearching && error === null ? (
          <EmptyState className="p-4 text-xs">No matching repos found.</EmptyState>
        ) : null}
        {localResults.map((repo) => (
          <div
            key={repo.id}
            className="bg-search-surface hover:border-foreground/30 grid gap-2 rounded-xl border p-2 transition md:grid-cols-[1fr_auto]"
          >
            <button
              type="button"
              className="flex items-center gap-2 text-left"
              onClick={() => onSelectLocal(repo)}
            >
              <RepoSourceIcon localPath={repo.localPath} />
              <div>
                <div className="text-sm font-medium">
                  {repo.owner}/{repo.name}
                </div>
                <div className="text-muted-foreground text-xs">Bookmarked repo</div>
              </div>
            </button>
            <Badge variant="secondary" className="text-caption self-center">
              <Star className="size-3 fill-current" />
              Bookmarked
            </Badge>
          </div>
        ))}
        {remoteResults.map((repo) => (
          <div
            key={hostedRepositoryLabel(repo)}
            className="bg-search-surface hover:border-foreground/30 grid gap-2 rounded-xl border p-2 transition md:grid-cols-[1fr_auto]"
          >
            <button
              type="button"
              className="flex items-center gap-2 text-left"
              onClick={() => onSelectRemote(repo)}
            >
              <Cloud className="text-muted-foreground size-3.5" />
              <div>
                <div className="text-sm font-medium">{hostedRepositoryLabel(repo)}</div>
                <div className="text-muted-foreground line-clamp-1 text-xs">
                  {repo.description ?? "Accessible repository"}
                </div>
              </div>
            </button>
            <Button
              size="sm"
              variant="secondary"
              className="self-center rounded-lg"
              onClick={() => onBookmark(repo)}
            >
              <Star className="size-3.5" />
              Bookmark
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

const RepoCard = ({
  loading,
  prCount,
  repo,
  selected,
  onSelect,
  onToggleBookmark,
}: {
  readonly loading: boolean
  readonly prCount: number | undefined
  readonly repo: Repo
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onToggleBookmark: () => void
}) => (
  <div
    className={`bg-background overflow-hidden rounded-xl border transition ${selected ? "border-primary ring-primary/15 ring-2" : ""}`}
  >
    <div className="grid grid-cols-[1fr_auto] items-stretch">
      <button
        type="button"
        className="flex min-w-0 items-center gap-2 p-3 text-left"
        onClick={onSelect}
      >
        {loading ? (
          <Loader2 className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
        ) : (
          <RepoSourceIcon localPath={repo.localPath} />
        )}
        <div className="min-w-0 space-y-0.5">
          <div className="truncate text-sm font-medium">
            {repo.owner}/{repo.name}
          </div>
          <div className="text-muted-foreground text-xs">
            {loading
              ? "Loading PRs..."
              : prCount === undefined
                ? "Checking PRs..."
                : `${prCount} open PR${prCount === 1 ? "" : "s"}`}
          </div>
        </div>
      </button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Remove bookmark for ${repo.owner}/${repo.name}`}
        className="m-2 self-start"
        onClick={onToggleBookmark}
      >
        <Star className="text-favorite size-3.5 fill-current" />
      </Button>
    </div>
  </div>
)

/** Hosted review row shared by Home preview and repository detail. */
export const PullRequestRow = ({
  pullRequest,
  onOpen,
}: {
  readonly pullRequest: HostedReviewSummary
  readonly onOpen: () => void
}) => (
  <button
    type="button"
    aria-label={`Open review #${pullRequest.locator.number}: ${pullRequest.title}`}
    className="bg-background hover:border-foreground/30 w-full space-y-3 rounded-2xl border p-4 text-left transition"
    onClick={onOpen}
  >
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-1">
        <div className="text-sm font-semibold">#{pullRequest.locator.number}</div>
        <div className="line-clamp-2 font-medium">{pullRequest.title}</div>
      </div>
      <PullRequestStateBadge isDraft={pullRequest.draft} state={pullRequest.state} />
    </div>
    <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
      <span className="inline-flex items-center gap-1">
        <UserRound className="size-3" />
        {pullRequest.author.username}
      </span>
      <span className="inline-flex items-center gap-1">
        <GitBranch className="size-3" />
        {pullRequest.head.name} into {pullRequest.base.name}
      </span>
    </div>
  </button>
)

const ReviewRequestRow = ({
  pullRequest,
  onOpen,
}: {
  readonly pullRequest: HostedReviewSummary
  readonly onOpen: () => void
}) => (
  <button
    type="button"
    aria-label={`Open requested review #${pullRequest.locator.number}: ${pullRequest.title}`}
    className="bg-background hover:border-foreground/30 w-full space-y-3 rounded-2xl border p-4 text-left transition"
    onClick={onOpen}
  >
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <div className="text-muted-foreground truncate text-xs font-medium">
          {pullRequest.locator.repository.namespace}/{pullRequest.locator.repository.name} #
          {pullRequest.locator.number}
        </div>
        <div className="line-clamp-2 font-medium">{pullRequest.title}</div>
      </div>
      <PullRequestStateBadge isDraft={pullRequest.draft} state={pullRequest.state} />
    </div>
    <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
      <span className="inline-flex items-center gap-1">
        <UserRound className="size-3" />
        {pullRequest.author.username}
      </span>
      <span className="inline-flex items-center gap-1">
        <GitBranch className="size-3" />
        {pullRequest.head.name} into {pullRequest.base.name}
      </span>
      <span>{pullRequest.updatedAt === null ? "Recently updated" : pullRequest.updatedAt}</span>
    </div>
  </button>
)

const RecentReviewRow = ({
  review,
  onOpen,
}: {
  readonly review: RecentReviewEntry
  readonly onOpen: () => void
}) => (
  <button
    type="button"
    aria-label={`Reopen review #${review.target.review.number}: ${review.title}`}
    className="bg-background hover:border-foreground/30 w-full space-y-3 rounded-2xl border p-4 text-left transition"
    onClick={onOpen}
  >
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <div className="text-muted-foreground truncate text-xs font-medium">
          {review.repoOwner}/{review.repoName} #{review.target.review.number}
        </div>
        <div className="line-clamp-2 font-medium">{review.title}</div>
      </div>
      <Badge variant="secondary" className="text-caption shrink-0">
        Recent
      </Badge>
    </div>
    <div className="text-muted-foreground text-xs">
      Last reviewed {formatTimestamp(review.lastReviewedAt, "Unknown date")}
    </div>
  </button>
)

const RepoSourceIcon = ({ localPath }: { readonly localPath: string | null }) =>
  localPath === null ? (
    <Cloud className="text-muted-foreground size-4 shrink-0" />
  ) : (
    <Laptop className="text-muted-foreground size-4 shrink-0" />
  )

const hostedRepositoryLabel = (repository: HostedRepository) =>
  `${repository.locator.namespace}/${repository.locator.name}`
