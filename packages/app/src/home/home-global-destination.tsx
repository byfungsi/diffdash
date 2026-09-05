import {
  GitProviderId,
  type GitProviderDescriptor,
  type HostedRepository,
  type HostedRepositoryLocator,
} from "@diffdash/domain/git-provider"
import type { Repo, RepositorySearchScope } from "@diffdash/domain/repository"
import { WebUrl } from "@diffdash/domain/web-url"
import { EMPTY_APP_PREREQUISITES } from "@diffdash/protocol/prerequisites"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { HashSet, Option } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import { useDeferredValue, useEffect, useState } from "react"

import type { GlobalNavigationDestinationProps } from "@/extensions/extension-registry"
import { diagnosticsAtom } from "@/onboarding/atoms"
import { runRendererPromise, useDesktopRuntime, useRepositories } from "@/platform/renderer-runtime"
import {
  providersAtom,
  remoteRepositorySearchAtom,
  remoteSearchAtomKey,
  repositoriesAtom,
  repositorySearchAtom,
  searchScopesAtom,
} from "@/repositories/atoms"
import { useRepositoryMutations } from "@/repositories/use-repository-mutations"
import { useCaptureAnalytics } from "@/shared/analytics"
import { formatError } from "@/shared/errors"
import { useApplicationCapabilities } from "@/platform/application-capabilities"
import { HomeScreen, hostedRepositoryLabel } from "./home-screen"

const EMPTY_PROVIDER_DESCRIPTORS: readonly GitProviderDescriptor[] = []
const EMPTY_REPOSITORY_SEARCH_SCOPES: readonly RepositorySearchScope[] = []
const EMPTY_REPOS: readonly Repo[] = []
const EMPTY_HOSTED_REPOSITORIES: readonly HostedRepository[] = []

/** Required host-owned Home destination, including its search, repository, and setup policy. */
export const HomeGlobalDestination = ({ host }: GlobalNavigationDestinationProps) => {
  const capabilities = useApplicationCapabilities()
  const captureAnalytics = useCaptureAnalytics()
  const desktop = useDesktopRuntime()
  const repositories = useRepositories()
  const [query, setQuery] = useState("")
  const [selectedSearchScope, setSelectedSearchScope] = useState<string | null>(null)
  const [selectedProviderId, setSelectedProviderId] = useState<GitProviderId | null>(null)
  const [actionStatus, setActionStatus] = useState("Search a repo or open a bookmark.")
  const [setupActionStatus, setSetupActionStatus] = useState<string | null>(null)
  const [debouncedRemoteSearchQuery, setDebouncedRemoteSearchQuery] = useState("")
  const deferredSearchQuery = useDeferredValue(query.trim())
  const localSearchQuery =
    selectedSearchScope === null
      ? deferredSearchQuery
      : `${selectedSearchScope}/${deferredSearchQuery}`

  useEffect(() => {
    const trimmedQuery = query.trim()
    if (trimmedQuery.length === 0) {
      setDebouncedRemoteSearchQuery("")
      return undefined
    }

    const timer = window.setTimeout(() => setDebouncedRemoteSearchQuery(trimmedQuery), 300)
    return () => window.clearTimeout(timer)
  }, [query])

  const repositoriesResult = useAtomValue(repositoriesAtom)
  const providersResult = useAtomValue(providersAtom)
  const availableProviders = AsyncResult.getOrElse(
    providersResult,
    () => EMPTY_PROVIDER_DESCRIPTORS,
  )
  const activeProviderId = selectedProviderId ?? availableProviders[0]?.id ?? null
  const selectedProvider =
    availableProviders.find((provider) => provider.id === activeProviderId) ??
    availableProviders[0] ??
    null
  const diagnosticsResult = useAtomValue(diagnosticsAtom)
  const providerSearchScopeKey =
    selectedProvider?.capabilities.searchScopes === true && activeProviderId !== null
      ? activeProviderId
      : ""
  const selectedProviderSearchScopesAtom = searchScopesAtom(providerSearchScopeKey)
  const searchScopesResult = useAtomValue(selectedProviderSearchScopesAtom)
  const searchScopes = AsyncResult.getOrElse(
    searchScopesResult,
    () => EMPTY_REPOSITORY_SEARCH_SCOPES,
  )
  const remoteSearchOwners =
    selectedProvider?.capabilities.repositorySearch !== true
      ? []
      : selectedSearchScope === null
        ? searchScopes.map((scope) => scope.login)
        : [selectedSearchScope]
  const remoteSearchKey =
    activeProviderId === null
      ? ""
      : remoteSearchAtomKey(activeProviderId, debouncedRemoteSearchQuery, remoteSearchOwners)
  const localSearchAtom = repositorySearchAtom(localSearchQuery)
  const remoteSearchAtom = remoteRepositorySearchAtom(remoteSearchKey)
  const localResultsResult = useAtomValue(localSearchAtom)
  const remoteResultsResult = useAtomValue(remoteSearchAtom)
  const refreshRepositories = useAtomRefresh(repositoriesAtom)
  const refreshProviders = useAtomRefresh(providersAtom)
  const refreshLocalSearch = useAtomRefresh(localSearchAtom)
  const refreshRemoteSearch = useAtomRefresh(remoteSearchAtom)
  const refreshDiagnostics = useAtomRefresh(diagnosticsAtom)
  const refreshSearchScopes = useAtomRefresh(selectedProviderSearchScopesAtom)
  const repositoryMutations = useRepositoryMutations({
    repositories: refreshRepositories,
    localSearch: refreshLocalSearch,
    remoteSearch: refreshRemoteSearch,
    selectedReviews: () => undefined,
  })

  const projects = AsyncResult.getOrElse(repositoriesResult, () => EMPTY_REPOS)
  const projectsStatus = AsyncResult.isFailure(repositoriesResult)
    ? resultErrorMessage(repositoriesResult, "Could not load projects")
    : null
  const hasQuery = query.trim().length > 0
  const localResults = hasQuery ? AsyncResult.getOrElse(localResultsResult, () => EMPTY_REPOS) : []
  const remoteResults =
    hasQuery && query.trim() === debouncedRemoteSearchQuery
      ? AsyncResult.getOrElse(remoteResultsResult, () => EMPTY_HOSTED_REPOSITORIES)
      : []
  const diagnostics = AsyncResult.getOrElse(diagnosticsResult, () => EMPTY_APP_PREREQUISITES)
  const isLoadingDiagnostics = AsyncResult.isWaiting(diagnosticsResult)
  const knownHostedRepoKeys = HashSet.fromIterable(
    projects.flatMap((repo) =>
      repo.hostedLocator === null ? [] : [hostedRepositoryKey(repo.hostedLocator)],
    ),
  )
  const uniqueRemoteResults = remoteResults.filter(
    (repo) => !HashSet.has(knownHostedRepoKeys, hostedRepositoryKey(repo.locator)),
  )
  const isSearching =
    hasQuery &&
    (query.trim() !== debouncedRemoteSearchQuery ||
      query.trim() !== deferredSearchQuery ||
      AsyncResult.isWaiting(searchScopesResult) ||
      AsyncResult.isWaiting(localResultsResult) ||
      AsyncResult.isWaiting(remoteResultsResult))
  const searchError = AsyncResult.isFailure(searchScopesResult)
    ? resultErrorMessage(searchScopesResult, "Could not load repository owners")
    : AsyncResult.isFailure(remoteResultsResult)
      ? resultErrorMessage(
          remoteResultsResult,
          `Could not search ${selectedProvider?.displayName ?? "hosted"} repositories`,
        )
      : null

  useEffect(() => {
    refreshRepositories()
    refreshProviders()
    refreshDiagnostics()
    refreshSearchScopes()
  }, [refreshDiagnostics, refreshProviders, refreshRepositories, refreshSearchScopes])

  useEffect(() => {
    if (
      availableProviders.length === 0 ||
      (selectedProviderId !== null &&
        availableProviders.some((provider) => provider.id === selectedProviderId))
    )
      return
    const firstProvider = availableProviders[0]
    if (firstProvider !== undefined) {
      setSelectedProviderId(firstProvider.id)
      setSelectedSearchScope(null)
    }
  }, [availableProviders, selectedProviderId])

  useEffect(() => {
    if (
      setupActionStatus === "Rechecking setup..." &&
      !isLoadingDiagnostics &&
      diagnostics.checkedAt.length > 0
    ) {
      setSetupActionStatus("Setup status refreshed.")
    }
  }, [diagnostics.checkedAt, isLoadingDiagnostics, setupActionStatus])

  const chooseProjectFolder = async () => {
    const localPath = await runRendererPromise(repositories.selectLocalFolder())
    if (Option.isSome(localPath)) await host.openProjectDirectory(localPath.value)
  }
  const pinRemote = async (repo: HostedRepository) => {
    const label = hostedRepositoryLabel(repo)
    try {
      await repositoryMutations.favorite(repo)
      setActionStatus(`Pinned ${label}.`)
      captureAnalytics({ event: "repository_bookmarked" })
    } catch (error) {
      setActionStatus(formatError(error, "Could not pin project"))
    }
  }
  const openRemoteRepository = async (repo: HostedRepository) => {
    try {
      const saved = await repositoryMutations.rememberRemote(repo)
      await host.openProject(saved)
    } catch (error) {
      setActionStatus(formatError(error, "Could not open hosted project"))
    }
  }
  const setRepositoryFavorite = async (repo: Repo, isFavorite: boolean) => {
    try {
      await repositoryMutations.setFavorite(repo, isFavorite)
      setActionStatus(`${isFavorite ? "Pinned" : "Unpinned"} ${repo.displayIdentity}.`)
    } catch (error) {
      setActionStatus(formatError(error, "Could not update project pin"))
    }
  }
  const forgetRepository = async (repo: Repo) => {
    try {
      await repositoryMutations.forget(repo.id)
      host.removeProjectHistory(repo.id)
      setActionStatus(`Forgot ${repo.displayIdentity} from Home. Project artifacts were kept.`)
    } catch (error) {
      setActionStatus(formatError(error, "Could not forget project"))
    }
  }
  const openSetupDocs = (url: string) => {
    void runRendererPromise(desktop.openExternalUrl(WebUrl.make(url))).catch((error) => {
      setSetupActionStatus(formatError(error, "Could not open setup documentation"))
    })
  }
  const installDiffDashCli = async () => {
    setSetupActionStatus("Installing the DiffDash CLI...")
    try {
      const result = await runRendererPromise(desktop.installCli())
      setSetupActionStatus(
        result.pathSetupCommand === null
          ? `Installed the DiffDash CLI at ${result.path}`
          : `Installed the DiffDash CLI at ${result.path}. For terminal access, add it to your shell with: ${result.pathSetupCommand}`,
      )
      refreshDiagnostics()
    } catch (error) {
      setSetupActionStatus(formatError(error, "Could not install the DiffDash CLI"))
    }
  }

  return (
    <>
      <span className="sr-only" aria-live="polite">
        {actionStatus}
      </span>
      <HomeScreen
        activeProviderId={activeProviderId}
        diagnostics={diagnostics}
        hasQuery={hasQuery}
        isLoadingDiagnostics={isLoadingDiagnostics}
        isSearching={isSearching}
        localProjectsEnabled={capabilities.localProjects}
        localResults={localResults}
        projects={projects}
        projectsStatus={projectsStatus}
        providers={availableProviders}
        query={query}
        remoteResults={uniqueRemoteResults}
        searchError={searchError}
        searchScopes={searchScopes}
        selectedProvider={selectedProvider}
        selectedSearchScope={selectedSearchScope}
        setupStatus={setupActionStatus}
        onForget={(repo) => void forgetRepository(repo)}
        onInstallDiffDashCli={() => void installDiffDashCli()}
        onOpenDocs={openSetupDocs}
        onOpenProject={() => void chooseProjectFolder()}
        onOpenRepo={(repo) => void host.openProject(repo)}
        onPinRemote={(repo) => void pinRemote(repo)}
        onQueryChange={setQuery}
        onRecheck={() => {
          setSetupActionStatus("Rechecking setup...")
          refreshDiagnostics()
        }}
        onRetryProjects={refreshRepositories}
        onSelectProvider={(providerId) => {
          setSelectedProviderId(GitProviderId.make(providerId))
          setSelectedSearchScope(null)
        }}
        onSelectRemote={(repo) => void openRemoteRepository(repo)}
        onSelectScope={(scope) =>
          setSelectedSearchScope((current) => (current === scope ? null : scope))
        }
        onSetFavorite={(repo, isFavorite) => void setRepositoryFavorite(repo, isFavorite)}
      />
    </>
  )
}

const hostedRepositoryKey = (locator: HostedRepositoryLocator): string =>
  `${locator.providerId}\u0000${locator.namespace}\u0000${locator.name}`

const resultErrorMessage = <Value, Failure>(
  result: AsyncResult.AsyncResult<Value, Failure>,
  fallback: string,
): string =>
  AsyncResult.matchWithError(result, {
    onInitial: () => fallback,
    onError: (error) => formatError(error, fallback),
    onDefect: (defect) => formatError(defect, fallback),
    onSuccess: () => fallback,
  })
