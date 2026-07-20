/* oxlint-disable eslint/no-underscore-dangle -- Domain unions use Effect-compatible _tag discriminants. */
import type { ReviewDecision } from "@diffdash/domain/git-provider"
import type { ReviewFilePatchHash } from "@diffdash/domain/review-identity"
import type { StoredWalkthrough } from "@diffdash/domain/walkthrough"
import type { DiffDashApi } from "@diffdash/protocol/api"
import {
  GenerateHostedWalkthroughRequest,
  HostedReviewRequest,
  HostedWalkthroughRequest,
  OpenHostedReviewFileRequest,
  SubmitHostedReviewDecisionRequest,
} from "@diffdash/protocol/hosted-git"
import {
  HostedViewedFilesRequest,
  LocalViewedFilesRequest,
  SetHostedViewedFileRequest,
  SetLocalViewedFileRequest,
  type ViewedFileRecord,
} from "@diffdash/protocol/viewed-files"
import type { ReviewSelectionProjection } from "./review-selection"
import { localReviewTargetFromDetail } from "./review-subject"

/** One optimistic viewed-file write normalized across review sources. */
export type ReviewViewedFileWrite = {
  readonly reviewKey: string
  readonly patchHash: ReviewFilePatchHash
  readonly viewed: boolean
}

/** Hosted review-decision operations, tagged separately from unsupported sources. */
type ReviewDecisionOperations =
  | { readonly _tag: "unsupported" }
  | {
      readonly _tag: "supported"
      readonly get: () => Promise<ReviewDecision>
      readonly approve: () => Promise<void>
    }

/** Review-source operations consumed by review UI without hosted/local branching. */
export type ReviewSourceOperations = {
  readonly source: "hosted" | "local"
  readonly refresh: () => void
  readonly listViewedFiles: () => Promise<readonly ViewedFileRecord[]>
  readonly setViewedFile: (write: ReviewViewedFileWrite) => Promise<void>
  readonly getWalkthrough: () => Promise<StoredWalkthrough | null>
  readonly generateWalkthrough: (regenerate: boolean) => Promise<StoredWalkthrough>
  readonly openFile: (path: string) => Promise<void>
  readonly decision: ReviewDecisionOperations
}

/** Platform methods needed by source-operation mapping. */
export type ReviewSourceOperationApi = {
  readonly hostedReviews: Pick<DiffDashApi["hostedReviews"], "getDecision" | "submitDecision">
  readonly localWalkthroughs: DiffDashApi["localWalkthroughs"]
  readonly openLocalRepositoryFile: DiffDashApi["openLocalRepositoryFile"]
  readonly openRepositoryFile: DiffDashApi["openRepositoryFile"]
  readonly viewedFiles: DiffDashApi["viewedFiles"]
  readonly walkthroughs: DiffDashApi["walkthroughs"]
}

/** Dependencies that remain outside source-specific request construction. */
type ReviewSourceOperationDependencies = {
  readonly api: ReviewSourceOperationApi
  readonly refreshHosted: () => void
  readonly refreshLocal: () => void
}

/** Purely maps a ready review projection to its supported source operations. */
export const mapReviewSourceOperations = (
  selection: Extract<ReviewSelectionProjection, { readonly _tag: "ready" }>,
  dependencies: ReviewSourceOperationDependencies,
): ReviewSourceOperations => {
  if (selection.subject.kind === "hosted") {
    const summary = selection.subject.hostedReview.summary
    const decision: ReviewDecisionOperations =
      selection.source._tag === "hosted" &&
      selection.source.provider?.capabilities.reviewDecisions === true
        ? {
            _tag: "supported",
            get: () =>
              dependencies.api.hostedReviews.getDecision(
                HostedReviewRequest.make({ review: summary.locator }),
              ),
            approve: () =>
              dependencies.api.hostedReviews.submitDecision(
                SubmitHostedReviewDecisionRequest.make({
                  review: summary.locator,
                  decision: "approved",
                }),
              ),
          }
        : { _tag: "unsupported" }

    return {
      source: "hosted",
      refresh: dependencies.refreshHosted,
      listViewedFiles: () =>
        dependencies.api.viewedFiles.list(
          HostedViewedFilesRequest.make({
            review: summary.locator,
            baseRefName: summary.base.name,
          }),
        ),
      setViewedFile: (write) =>
        dependencies.api.viewedFiles.set(
          SetHostedViewedFileRequest.make({
            review: summary.locator,
            baseRefName: summary.base.name,
            ...write,
          }),
        ),
      getWalkthrough: () =>
        dependencies.api.walkthroughs.get(
          HostedWalkthroughRequest.make({
            review: summary.locator,
            baseRevision: selection.manifest.baseRevision,
            headRevision: selection.manifest.headRevision,
          }),
        ),
      generateWalkthrough: (regenerate) =>
        dependencies.api.walkthroughs.generate(
          GenerateHostedWalkthroughRequest.make({ review: summary.locator, regenerate }),
        ),
      openFile: (path) =>
        dependencies.api.openRepositoryFile(
          OpenHostedReviewFileRequest.make({
            review: summary.locator,
            filePath: path,
            headRefName: summary.head.name,
            headRevision: summary.head.revision,
          }),
        ),
      decision,
    }
  }

  const detail = selection.subject.localReview
  const target = localReviewTargetFromDetail(detail)
  return {
    source: "local",
    refresh: dependencies.refreshLocal,
    listViewedFiles: () =>
      dependencies.api.viewedFiles.listLocal(
        LocalViewedFilesRequest.make({ target, sourceBranch: detail.branchName }),
      ),
    setViewedFile: (write) =>
      dependencies.api.viewedFiles.setLocal(
        SetLocalViewedFileRequest.make({
          target,
          sourceBranch: detail.branchName,
          ...write,
        }),
      ),
    getWalkthrough: () =>
      dependencies.api.localWalkthroughs.get(
        target,
        selection.manifest.baseRevision,
        selection.manifest.headRevision,
      ),
    generateWalkthrough: (regenerate) =>
      regenerate
        ? dependencies.api.localWalkthroughs.regenerate(target)
        : dependencies.api.localWalkthroughs.generate(target),
    openFile: (path) => dependencies.api.openLocalRepositoryFile(detail.rootPath, path),
    decision: { _tag: "unsupported" },
  }
}
