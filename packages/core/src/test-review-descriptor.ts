import { LocalReviewTarget, WorkingTreeComparison } from "@diffdash/domain/local-review"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { LocalReviewDescriptor } from "@diffdash/domain/review-context"

/** Minimal valid durable descriptor shared by snapshot persistence tests. */
export const testReviewDescriptor = LocalReviewDescriptor.make({
  target: LocalReviewTarget.make({
    kind: "local",
    rootPath: RepositoryCheckoutPath.make("/tmp/diffdash"),
    comparison: WorkingTreeComparison.make({}),
  }),
  repoName: "diffdash",
  branchName: null,
  title: "Local changes",
  fetchedAt: "2026-08-16T00:00:00.000Z",
})
