import type { GitProviderDescriptor, HostedRepository } from "@diffdash/domain/git-provider"
import type { Repo, RepositorySearchScope } from "@diffdash/domain/repository"
import type { AppPrerequisites } from "@diffdash/protocol/prerequisites"
import {
  Cloud,
  FolderOpen,
  Laptop,
  Loader2,
  Pin,
  Search,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react"

import { SetupBanner, missingPrerequisiteRows } from "@/onboarding/onboarding-screen"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card"
import { EmptyState } from "@/shared/ui/empty-state"
import { Input } from "@/shared/ui/input"
import { Surface } from "@/shared/ui/surface"

/** Maximum non-pinned projects shown in Home recency order. */
export const HOME_RECENT_PROJECT_LIMIT = 8

/** Presentational state for the projects-only Home feature. */
interface HomeScreenProps {
  readonly activeProviderId: string | null
  readonly diagnostics: AppPrerequisites
  readonly hasQuery: boolean
  readonly isLoadingDiagnostics: boolean
  readonly isSearching: boolean
  readonly localProjectsEnabled: boolean
  readonly localResults: readonly Repo[]
  readonly projects: readonly Repo[]
  readonly projectsStatus: string | null
  readonly providers: readonly GitProviderDescriptor[]
  readonly query: string
  readonly remoteResults: readonly HostedRepository[]
  readonly searchError: string | null
  readonly searchScopes: readonly RepositorySearchScope[]
  readonly selectedProvider: GitProviderDescriptor | null
  readonly selectedSearchScope: string | null
  readonly setupStatus: string | null
  readonly onForget: (repo: Repo) => void
  readonly onInstallDiffDashCli: () => void
  readonly onOpenDocs: (url: string) => void
  readonly onOpenProject: () => void
  readonly onOpenRepo: (repo: Repo) => void
  readonly onPinRemote: (repo: HostedRepository) => void
  readonly onQueryChange: (query: string) => void
  readonly onRecheck: () => void
  readonly onRetryProjects: () => void
  readonly onSelectProvider: (providerId: string) => void
  readonly onSelectRemote: (repo: HostedRepository) => void
  readonly onSelectScope: (scope: string) => void
  readonly onSetFavorite: (repo: Repo, isFavorite: boolean) => void
}

/** Projects-only Home with project opening, search, pinning, and recency management. */
export const HomeScreen = ({
  activeProviderId,
  diagnostics,
  hasQuery,
  isLoadingDiagnostics,
  isSearching,
  localProjectsEnabled,
  localResults,
  projects,
  projectsStatus,
  providers,
  query,
  remoteResults,
  searchError,
  searchScopes,
  selectedProvider,
  selectedSearchScope,
  setupStatus,
  onForget,
  onInstallDiffDashCli,
  onOpenDocs,
  onOpenProject,
  onOpenRepo,
  onPinRemote,
  onQueryChange,
  onRecheck,
  onRetryProjects,
  onSelectProvider,
  onSelectRemote,
  onSelectScope,
  onSetFavorite,
}: HomeScreenProps) => {
  const pinnedProjects = projects.filter((project) => project.isFavorite)
  const recentProjects = projects
    .filter((project) => project.lastOpenedAt !== null && !project.isFavorite)
    .reduce<Repo[]>((ordered, project) => {
      const insertionIndex = ordered.findIndex(
        (candidate) => (candidate.lastOpenedAt ?? "") < (project.lastOpenedAt ?? ""),
      )
      ordered.splice(insertionIndex < 0 ? ordered.length : insertionIndex, 0, project)
      return ordered
    }, [])
    .slice(0, HOME_RECENT_PROJECT_LIMIT)

  return (
    <section className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5 text-sm sm:gap-6 sm:px-6 sm:py-7">
      <header className="flex flex-col gap-4 pt-1 sm:flex-row sm:items-center sm:justify-between sm:pt-3">
        <div className="space-y-3">
          <Badge
            variant="outline"
            data-home-version
            className="text-caption border-primary/40 bg-primary/10 text-primary w-fit gap-1.5 font-semibold tracking-wide"
          >
            <Sparkles className="size-3" />
            {import.meta.env.VITE_APP_VERSION}
          </Badge>
          <div className="space-y-2">
            <h1 className="max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl">
              DiffDash
            </h1>
            <p className="text-muted-foreground max-w-3xl text-sm leading-6">
              {localProjectsEnabled
                ? `Open a project, choose local changes or a hosted ${selectedProvider?.terminology.reviewSingular ?? "review"}, and keep each workspace where you left it.`
                : `Find a GitHub repository, open a ${selectedProvider?.terminology.reviewSingular ?? "review"}, and keep each workspace where you left it.`}
            </p>
          </div>
        </div>
        {localProjectsEnabled ? (
          <div className="flex w-full shrink-0 gap-2 sm:w-auto">
            <Button className="flex-1 sm:flex-none" onClick={onOpenProject}>
              <FolderOpen className="size-4" />
              Open project
            </Button>
          </div>
        ) : null}
      </header>

      {localProjectsEnabled &&
      !isLoadingDiagnostics &&
      missingPrerequisiteRows(diagnostics).length > 0 ? (
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
                className="h-10 border-0 bg-transparent pr-9 pl-9 text-sm shadow-none focus-visible:border-0 focus-visible:bg-transparent focus-visible:ring-0"
                placeholder={
                  localProjectsEnabled
                    ? "Search local and hosted projects"
                    : "Search GitHub repositories"
                }
                onChange={(event) => onQueryChange(event.target.value)}
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
                error={searchError}
                isSearching={isSearching}
                localResults={localResults}
                remoteResults={remoteResults}
                scopes={searchScopes}
                selectedScope={selectedSearchScope}
                onOpenLocal={onOpenRepo}
                onOpenRemote={onSelectRemote}
                onPinRemote={onPinRemote}
                onSelectScope={onSelectScope}
              />
            ) : null}
          </Surface>
        </div>
      </div>

      <div data-home-layout className="grid min-w-0 gap-4 lg:grid-cols-2 lg:items-start">
        <ProjectSection
          dataSection="pinned"
          description="Pinned projects stay at the top of Home."
          empty={
            localProjectsEnabled
              ? "Pin a project or open a local checkout to get started."
              : "Search for a GitHub repository and pin it to get started."
          }
          projects={pinnedProjects}
          status={projectsStatus}
          title="Pinned projects"
          onForget={onForget}
          onOpen={onOpenRepo}
          onRetry={onRetryProjects}
          onSetFavorite={onSetFavorite}
        />
        <ProjectSection
          dataSection="recent"
          description={`The ${HOME_RECENT_PROJECT_LIMIT} most recently opened unpinned projects.`}
          empty="Recently opened projects will appear here."
          projects={recentProjects}
          status={projectsStatus}
          title="Recent projects"
          onForget={onForget}
          onOpen={onOpenRepo}
          onRetry={onRetryProjects}
          onSetFavorite={onSetFavorite}
        />
      </div>
    </section>
  )
}

const ProjectSection = ({
  dataSection,
  description,
  empty,
  projects,
  status,
  title,
  onForget,
  onOpen,
  onRetry,
  onSetFavorite,
}: {
  readonly dataSection: "pinned" | "recent"
  readonly description: string
  readonly empty: string
  readonly projects: readonly Repo[]
  readonly status: string | null
  readonly title: string
  readonly onForget: (repo: Repo) => void
  readonly onOpen: (repo: Repo) => void
  readonly onRetry: () => void
  readonly onSetFavorite: (repo: Repo, isFavorite: boolean) => void
}) => (
  <Card data-home-section={dataSection} className="min-w-0">
    <CardHeader className="border-border-subtle border-b pb-4">
      <CardTitle>{title}</CardTitle>
      <CardDescription>{description}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      {status !== null ? (
        <EmptyState className="space-y-3">
          <p>{status}</p>
          <Button variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </EmptyState>
      ) : projects.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            showForget={dataSection === "recent"}
            onForget={() => onForget(project)}
            onOpen={() => onOpen(project)}
            onSetFavorite={(favorite) => onSetFavorite(project, favorite)}
          />
        ))
      )}
    </CardContent>
  </Card>
)

const ProjectCard = ({
  project,
  showForget,
  onForget,
  onOpen,
  onSetFavorite,
}: {
  readonly project: Repo
  readonly showForget: boolean
  readonly onForget: () => void
  readonly onOpen: () => void
  readonly onSetFavorite: (favorite: boolean) => void
}) => (
  <article className="bg-surface-inset border-border-subtle hover:border-border grid grid-cols-[minmax(0,1fr)_auto] overflow-hidden rounded-md border transition-colors">
    <button
      type="button"
      aria-label={`Open project ${project.displayIdentity}`}
      className="flex min-w-0 items-center gap-3 p-3 text-left"
      onClick={onOpen}
    >
      <RepoSourceIcon repo={project} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{project.displayIdentity}</span>
        <span className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
          <span>{projectIdentityLabel(project)}</span>
          {project.localPath === null ? null : (
            <span className="truncate">· {project.localPath}</span>
          )}
        </span>
      </span>
    </button>
    <div className="flex items-center gap-1 pr-2">
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`${project.isFavorite ? "Unpin" : "Pin"} ${project.displayIdentity}`}
        title={project.isFavorite ? "Unpin project" : "Pin project"}
        onClick={() => onSetFavorite(!project.isFavorite)}
      >
        {project.isFavorite ? (
          <Star className="text-favorite size-3.5 fill-current" />
        ) : (
          <Pin className="size-3.5" />
        )}
      </Button>
      {showForget ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Forget ${project.displayIdentity}`}
          title="Forget project from Home"
          onClick={onForget}
        >
          <Trash2 className="size-3.5" />
        </Button>
      ) : null}
    </div>
  </article>
)

const SearchResults = ({
  error,
  isSearching,
  localResults,
  remoteResults,
  scopes,
  selectedScope,
  onOpenLocal,
  onOpenRemote,
  onPinRemote,
  onSelectScope,
}: {
  readonly error: string | null
  readonly isSearching: boolean
  readonly localResults: readonly Repo[]
  readonly remoteResults: readonly HostedRepository[]
  readonly scopes: readonly RepositorySearchScope[]
  readonly selectedScope: string | null
  readonly onOpenLocal: (repo: Repo) => void
  readonly onOpenRemote: (repo: HostedRepository) => void
  readonly onPinRemote: (repo: HostedRepository) => void
  readonly onSelectScope: (scope: string) => void
}) => {
  const hasResults = localResults.length > 0 || remoteResults.length > 0
  return (
    <div className="bg-search-surface max-h-search-results overflow-y-auto p-3 pt-0">
      <div className="flex flex-wrap gap-1.5">
        {scopes.map((scope) => {
          const selected = selectedScope === scope.login
          return (
            <button
              key={`${scope.kind}:${scope.login}`}
              type="button"
              aria-pressed={selected}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                selected
                  ? "border-border-selected bg-surface-selected text-primary"
                  : "border-border-subtle bg-muted text-muted-foreground hover:border-border hover:bg-secondary"
              }`}
              onClick={() => onSelectScope(scope.login)}
            >
              {scope.login}
            </button>
          )
        })}
      </div>
      <div className="mt-4 space-y-1.5">
        {error === null ? null : (
          <div
            role="alert"
            className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border p-3 text-xs"
          >
            {error}
          </div>
        )}
        {!hasResults && !isSearching && error === null ? (
          <EmptyState className="p-4 text-xs">No matching projects found.</EmptyState>
        ) : null}
        {localResults.map((project) => (
          <button
            key={project.id}
            type="button"
            className="bg-search-surface border-border-subtle hover:border-border hover:bg-secondary flex w-full items-center gap-2 rounded-xl border p-2 text-left transition"
            onClick={() => onOpenLocal(project)}
          >
            <RepoSourceIcon repo={project} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{project.displayIdentity}</span>
              <span className="text-muted-foreground block truncate text-xs">
                {projectIdentityLabel(project)}
              </span>
            </span>
          </button>
        ))}
        {remoteResults.map((project) => (
          <div
            key={hostedRepositoryLabel(project)}
            className="bg-search-surface border-border-subtle hover:border-border hover:bg-secondary grid gap-2 rounded-xl border p-2 transition md:grid-cols-[1fr_auto]"
          >
            <button
              type="button"
              className="flex min-w-0 items-center gap-2 text-left"
              onClick={() => onOpenRemote(project)}
            >
              <Cloud className="text-muted-foreground size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {hostedRepositoryLabel(project)}
                </span>
                <span className="text-muted-foreground line-clamp-1 text-xs">
                  {project.description ?? "Hosted project"}
                </span>
              </span>
            </button>
            <Button size="sm" variant="secondary" onClick={() => onPinRemote(project)}>
              <Pin className="size-3.5" />
              Pin
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

const RepoSourceIcon = ({ repo }: { readonly repo: Repo }) =>
  repo.localPath === null ? (
    <Cloud className="text-muted-foreground size-4 shrink-0" />
  ) : (
    <Laptop className="text-muted-foreground size-4 shrink-0" />
  )

const projectIdentityLabel = (project: Repo) => {
  if (project.hostedLocator === null) return "Local only"
  return project.localPath === null ? "Hosted" : "Hosted + local"
}

/** Formats a hosted repository for home-screen presentation and related actions. */
export const hostedRepositoryLabel = (repository: HostedRepository) =>
  `${repository.locator.namespace}/${repository.locator.name}`
