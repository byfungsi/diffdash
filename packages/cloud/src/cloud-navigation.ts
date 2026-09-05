import {
  createDefaultApplicationLocation,
  createReviewApplicationLocation,
  readReviewApplicationLocation,
  type ApplicationLocation,
  type ApplicationNavigation,
} from "@diffdash/app"
import { makeHostedReviewLocator } from "@diffdash/domain/git-provider"
import { Schema } from "effect"
import type { CloudStorage } from "./cloud-storage"
import { GithubClient, GithubRequestError } from "./github-client"
import {
  CloudReviewRouteError,
  formatCloudReviewRoute,
  parseCloudReviewRoute,
  type CloudReviewRoute,
} from "./cloud-review-route"

/** Browser URL operations used by Cloud navigation and deterministic history tests. */
export interface CloudNavigationHistory {
  readonly pathname: () => string
  readonly push: (pathname: string) => void
  readonly subscribe: (listener: () => void) => () => void
}

/** Transient route resolution state; failures never silently select a different review. */
export type CloudNavigationStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "error"; readonly message: string }

/** Resolves URL destinations after authentication and synchronizes browser Back/Forward. */
export const createCloudNavigation = (
  github: Pick<GithubClient, "getRepository" | "resolveCommit" | "resolveComparison">,
  storage: Pick<CloudStorage, "saveHostedRepository">,
  history: CloudNavigationHistory,
  onStatus: (status: CloudNavigationStatus) => void,
): ApplicationNavigation => {
  let generation = 0
  let applying = false
  let ready = false
  let lastLocationPath: string | null = null

  const resolve = async (route: CloudReviewRoute): Promise<ApplicationLocation> => {
    if (route.kind === "home") return createDefaultApplicationLocation()
    const repository = await github.getRepository(route.owner, route.repo)
    const repo = await storage.saveHostedRepository(repository, false)
    if (route.kind === "repository") return createReviewApplicationLocation(repo, null)
    if (route.kind === "pull") {
      const review = makeHostedReviewLocator(
        "github",
        repository.locator.namespace,
        repository.locator.name,
        route.number,
      )
      return createReviewApplicationLocation(
        repo,
        route.view === "files"
          ? { kind: "hosted", review, view: "files" }
          : { kind: "hosted", review },
      )
    }
    if (route.kind === "commit") {
      return createReviewApplicationLocation(repo, {
        kind: "repositoryComparison",
        target: await github.resolveCommit(
          repository.locator.namespace,
          repository.locator.name,
          route.ref,
        ),
      })
    }
    return createReviewApplicationLocation(repo, {
      kind: "repositoryComparison",
      target: await github.resolveComparison(
        repository.locator.namespace,
        repository.locator.name,
        route.base,
        route.head,
      ),
    })
  }

  return {
    subscribe: (navigate) => {
      const load = async () => {
        const requestGeneration = ++generation
        ready = false
        onStatus({ kind: "loading" })
        try {
          const location = await resolve(parseCloudReviewRoute(history.pathname()))
          if (requestGeneration !== generation) return
          applying = true
          try {
            if (!navigate(location))
              throw new CloudReviewRouteError({
                message: "The review navigation extension is unavailable.",
              })
          } finally {
            applying = false
          }
          lastLocationPath = applicationLocationPath(location)
          ready = true
          onStatus({ kind: "ready" })
        } catch (error) {
          if (requestGeneration !== generation) return
          onStatus({
            kind: "error",
            message: Schema.is(CloudReviewRouteError)(error)
              ? error.message
              : Schema.is(GithubRequestError)(error)
                ? error.safeMessage
                : "DiffDash could not open this review URL. Try reloading the page.",
          })
        }
      }
      const unsubscribe = history.subscribe(() => {
        void load()
      })
      void load()
      return () => {
        generation += 1
        unsubscribe()
      }
    },
    publish: (location) => {
      if (applying || !ready) return
      const path = applicationLocationPath(location)
      if (path === null || path === lastLocationPath) return
      lastLocationPath = path
      history.push(path)
    },
  }
}

const applicationLocationPath = (location: ApplicationLocation): string | null => {
  if (location.kind === "global") return "/"
  const repository = location.repo.hostedLocator
  if (repository === null || repository.providerId !== "github") return null
  const selection = readReviewApplicationLocation(location)
  const owner = repository.namespace
  const repo = repository.name
  if (selection === null) return formatCloudReviewRoute({ kind: "repository", owner, repo })
  if (selection.kind === "hosted") {
    return formatCloudReviewRoute({
      kind: "pull",
      owner,
      repo,
      number: selection.review.number,
      view: selection.view ?? "overview",
    })
  }
  if (selection.kind === "repositoryComparison") {
    return formatCloudReviewRoute({
      kind: "compare",
      owner,
      repo,
      base: selection.target.baseRef,
      head: selection.target.headRef,
    })
  }
  return null
}
