/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
import { useAtomRefresh, useAtomSet } from "@effect/atom-react"
import { Effect, Option } from "effect"
import {
  runRendererPromise,
  useReviewAutomation,
  useReviewContent,
} from "@/platform/renderer-runtime"
import {
  hostedReviewManifestAtom,
  localReviewManifestAtom,
  repositoryComparisonManifestAtom,
  refreshPullRequestsAtom,
  repoKey,
} from "./atoms"
import type { ReviewSelectionProjection } from "./review-selection"
import { type ReviewSourceOperations, mapReviewSourceOperations } from "./review-source-operations"

/** Source-operation mapping while no ready review is available. */
export type ReviewSourceOperationProjection =
  | { readonly _tag: "unavailable" }
  | { readonly _tag: "ready"; readonly operations: ReviewSourceOperations }

/** Builds source operations after registering hosted and local refresh hooks unconditionally. */
export const useReviewSourceOperations = (
  selection: ReviewSelectionProjection,
): ReviewSourceOperationProjection => {
  const hostedKey =
    selection._tag === "ready" && selection.target.kind === "hosted" ? selection.sourceKey : ""
  const localKey =
    selection._tag === "ready" && selection.target.kind === "localDiff" ? selection.sourceKey : ""
  const refreshHostedManifest = useAtomRefresh(hostedReviewManifestAtom(hostedKey))
  const refreshLocalManifest = useAtomRefresh(localReviewManifestAtom(localKey))
  const comparisonKey =
    selection._tag === "ready" && selection.target.kind === "repositoryComparison"
      ? selection.sourceKey
      : ""
  const refreshRepositoryComparisonManifest = useAtomRefresh(
    repositoryComparisonManifestAtom(comparisonKey),
  )
  const refreshPullRequests = useAtomSet(refreshPullRequestsAtom)
  const automation = useReviewAutomation()
  const content = useReviewContent()

  if (selection._tag !== "ready") return { _tag: "unavailable" }

  return {
    _tag: "ready",
    operations: mapReviewSourceOperations(selection, {
      api: {
        hostedReviews: {
          getDecision: (request) => runRendererPromise(content.hostedReviews.getDecision(request)),
          submitDecision: (request) =>
            runRendererPromise(content.hostedReviews.submitDecision(request)),
        },
        localWalkthroughs: {
          get: (target, baseSha, headSha) =>
            runRendererPromise(
              automation.walkthroughs
                .getLocal(target, baseSha, headSha)
                .pipe(Effect.map(Option.getOrNull)),
            ),
          generate: (target) =>
            runRendererPromise(automation.walkthroughs.generateLocal(target, false)),
          regenerate: (target) =>
            runRendererPromise(automation.walkthroughs.generateLocal(target, true)),
        },
        openLocalRepositoryFile: (rootPath, filePath) =>
          runRendererPromise(content.openLocalFile(rootPath, filePath)),
        openRepositoryFile: (request) => runRendererPromise(content.openHostedFile(request)),
        repositoryComparisons: {
          openFile: (request) => runRendererPromise(content.openRepositoryComparisonFile(request)),
        },
        repositoryComparisonWalkthroughs: {
          get: (target) =>
            runRendererPromise(
              automation.walkthroughs
                .getRepositoryComparison(target)
                .pipe(Effect.map(Option.getOrNull)),
            ),
          generate: (target) =>
            runRendererPromise(automation.walkthroughs.generateRepositoryComparison(target, false)),
          regenerate: (target) =>
            runRendererPromise(automation.walkthroughs.generateRepositoryComparison(target, true)),
        },
        viewedFiles: {
          list: (request) => runRendererPromise(content.viewedFiles.listHosted(request)),
          set: (request) => runRendererPromise(content.viewedFiles.setHosted(request)),
          listLocal: (request) => runRendererPromise(content.viewedFiles.listLocal(request)),
          setLocal: (request) => runRendererPromise(content.viewedFiles.setLocal(request)),
          listRepositoryComparison: (request) =>
            runRendererPromise(content.viewedFiles.listRepositoryComparison(request)),
          setRepositoryComparison: (request) =>
            runRendererPromise(content.viewedFiles.setRepositoryComparison(request)),
        },
        walkthroughs: {
          get: (request) =>
            runRendererPromise(
              automation.walkthroughs.getHosted(request).pipe(Effect.map(Option.getOrNull)),
            ),
          generate: (request) =>
            runRendererPromise(automation.walkthroughs.generateHosted(request)),
        },
      },
      refreshHosted: () => {
        refreshHostedManifest()
        if (selection.target.kind === "hosted") {
          refreshPullRequests(
            repoKey(
              selection.target.review.repository.providerId,
              selection.target.review.repository.namespace,
              selection.target.review.repository.name,
            ),
          )
        }
      },
      refreshLocal: refreshLocalManifest,
      refreshRepositoryComparison: refreshRepositoryComparisonManifest,
    }),
  }
}
