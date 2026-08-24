import { LocalReviewTarget, RevisionRangeComparison } from "@diffdash/domain/local-review"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { createRoot, type Root } from "react-dom/client"
import { useEffect } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  OwnedExtensionContribution,
  ReviewDiffContribution,
  ReviewDiffContributionOutput,
  ReviewDiffContributionProps,
} from "@/extensions/extension-registry"
import { TrustedExtensionContributionId, TrustedExtensionId } from "@/extensions/extension-registry"
import {
  useReviewDiffContributionHost,
  useReviewDiffContributionRegistration,
} from "./review-diff-contribution-host"

let root: Root | null = null
const baseRevision = ReviewRevision.make("1".repeat(40))
const headRevision = ReviewRevision.make("2".repeat(40))
const props = {
  projectId: ReviewProjectId.make("review-contribution-host"),
  target: LocalReviewTarget.make({
    kind: "local",
    rootPath: RepositoryCheckoutPath.make("/workspace/review-contribution-host"),
    comparison: RevisionRangeComparison.make({
      baseRef: RepositoryComparisonRef.make("main"),
      headRef: RepositoryComparisonRef.make("HEAD"),
      baseSha: baseRevision,
      headSha: headRevision,
      mergeBaseSha: baseRevision,
    }),
  }),
  baseRevision,
  headRevision,
}

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

describe("ReviewDiffContributionHost", () => {
  it("projects ordered outputs and removes only the disposed owner mount", async () => {
    const firstRendered = vi.fn<(card: HTMLElement) => void>()
    const secondRendered = vi.fn<(card: HTMLElement) => void>()
    const first = contribution("example.review.first", 200, "first", firstRendered)
    const second = contribution("example.review.second", 100, "second", secondRendered)
    render([first, second])

    await vi.waitFor(() => expect(outputLabels()).toEqual(["second", "first"]))
    document.querySelector<HTMLButtonElement>("[data-notify-review-annotations]")?.click()
    expect(firstRendered).toHaveBeenCalledOnce()
    expect(secondRendered).toHaveBeenCalledOnce()
    render([first])
    await vi.waitFor(() => expect(outputLabels()).toEqual(["first"]))
  })

  it("remounts contribution state when the exact review scope changes", async () => {
    const mounted = vi.fn<() => void>()
    const unmounted = vi.fn<() => void>()
    const output = emptyOutput("scoped")
    function ScopedContribution() {
      useReviewDiffContributionRegistration(output)
      useEffect(() => {
        mounted()
        return unmounted
      }, [])
      return null
    }
    const scoped = {
      id: TrustedExtensionContributionId.make("example.review.scoped"),
      order: 100,
      ownerExtensionId: TrustedExtensionId.make("example.review.extension"),
      component: ScopedContribution,
    }
    render([scoped])
    await vi.waitFor(() => expect(mounted).toHaveBeenCalledOnce())

    render([scoped], { ...props, headRevision: ReviewRevision.make("3".repeat(40)) })
    await vi.waitFor(() => {
      expect(unmounted).toHaveBeenCalledOnce()
      expect(mounted).toHaveBeenCalledTimes(2)
    })
  })
})

const contribution = (
  id: string,
  order: number,
  label: string,
  annotationsRendered: (card: HTMLElement) => void = () => undefined,
): OwnedExtensionContribution<ReviewDiffContribution> => {
  const output = { ...emptyOutput(label), annotationsRendered }
  function TestReviewContribution() {
    useReviewDiffContributionRegistration(output)
    return null
  }
  return {
    id: TrustedExtensionContributionId.make(id),
    order,
    ownerExtensionId: TrustedExtensionId.make("example.review.extension"),
    component: TestReviewContribution,
  }
}

const emptyOutput = (label: string): ReviewDiffContributionOutput => ({
  activeLineAnchor: null,
  details: [],
  loading: false,
  listOpen: false,
  detailOpen: false,
  annotations: () => [],
  activateLine: () => false,
  annotationsRendered: () => undefined,
  openDetail: () => undefined,
  revealLine: () => undefined,
  showList: () => undefined,
  collapse: () => undefined,
  renderContextPane: () => <span data-review-output={label}>{label}</span>,
  renderDetailPane: () => null,
})

const Harness = ({
  contributions,
  reviewProps,
}: {
  readonly contributions: readonly OwnedExtensionContribution<ReviewDiffContribution>[]
  readonly reviewProps: ReviewDiffContributionProps
}) => {
  const host = useReviewDiffContributionHost(contributions, reviewProps)
  return (
    <>
      {host.mounts}
      {host.outputs.map(({ id, output }) => (
        <div key={id}>
          {output.renderContextPane({
            navigableThreadIds: new Set(),
            settings: null,
            onCollapse: () => undefined,
          })}
        </div>
      ))}
      <button
        type="button"
        aria-label="Notify review annotations rendered"
        data-notify-review-annotations
        onClick={() => host.semantic.annotationsRendered(document.body)}
      />
    </>
  )
}

const render = (
  contributions: readonly OwnedExtensionContribution<ReviewDiffContribution>[],
  reviewProps: ReviewDiffContributionProps = props,
) => {
  const container = document.body.firstElementChild ?? document.createElement("div")
  if (!container.isConnected) {
    document.body.append(container)
    root = createRoot(container)
  }
  root?.render(<Harness contributions={contributions} reviewProps={reviewProps} />)
}

const outputLabels = () =>
  [...document.querySelectorAll<HTMLElement>("[data-review-output]")].map(
    (element) => element.dataset.reviewOutput,
  )
