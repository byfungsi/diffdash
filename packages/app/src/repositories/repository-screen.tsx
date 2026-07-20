import type { HostedReviewSummary } from "@diffdash/domain/git-provider"
import type { Repo } from "@diffdash/domain/repository"
import { ArrowLeft } from "lucide-react"
import { PullRequestRow } from "@/home/home-screen"
import { Button } from "@/shared/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card"
import { EmptyState } from "@/shared/ui/empty-state"

/** Full hosted-review list for one selected repository. */
export const RepositoryScreen = ({
  isLoading,
  pullRequests,
  repo,
  status,
  onBack,
  onOpenReview,
}: {
  readonly isLoading: boolean
  readonly pullRequests: readonly HostedReviewSummary[]
  readonly repo: Repo
  readonly status: string
  readonly onBack: () => void
  readonly onOpenReview: (pullRequest: HostedReviewSummary) => void
}) => (
  <section className="mx-auto flex max-w-5xl flex-col gap-6 px-8 py-10">
    <Button variant="ghost" className="w-fit" onClick={onBack}>
      <ArrowLeft className="size-4" />
      Home
    </Button>
    <Card>
      <CardHeader>
        <CardTitle>
          {repo.owner}/{repo.name}
        </CardTitle>
        <CardDescription>{status}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? <EmptyState>Loading PRs...</EmptyState> : null}
        {!isLoading && pullRequests.length === 0 ? (
          <EmptyState>No open PRs found.</EmptyState>
        ) : null}
        {pullRequests.map((pullRequest) => (
          <PullRequestRow
            key={pullRequest.locator.number}
            pullRequest={pullRequest}
            onOpen={() => onOpenReview(pullRequest)}
          />
        ))}
      </CardContent>
    </Card>
  </section>
)
