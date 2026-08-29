import { LocalReviewTarget, RevisionRangeComparison } from "@diffdash/domain/local-review"
import { LocalCommentNoteContext } from "@diffdash/domain/comment-note"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryComparisonRef } from "@diffdash/domain/repository-comparison"
import { ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { Option, Result } from "effect"
import { createRoot, type Root } from "react-dom/client"
import { useEffect } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  OwnedExtensionContribution,
  ReviewDiffContribution,
  ReviewDiffContributionOutput,
  ReviewDiffContributionProps,
  TrustedBuiltInExtension,
} from "@/extensions/extension-registry"
import {
  makeTrustedExtensionRegistry,
  TrustedExtensionContributionId,
  TrustedExtensionId,
  TrustedExtensionRegistrationToken,
} from "@/extensions/extension-registry"
import {
  TrustedExtensionRegistryProvider,
  useTrustedExtensionRegistry,
} from "@/extensions/extension-registry-context"
import { reviewExtension } from "@/extensions/review/review-extension"
import {
  useReviewDiffContributionHost,
  useReviewDiffContributionRegistration,
} from "./review-diff-contribution-host"

let root: Root | null = null
const baseRevision = ReviewRevision.make("1".repeat(40))
const headRevision = ReviewRevision.make("2".repeat(40))
const target = LocalReviewTarget.make({
  kind: "local",
  rootPath: RepositoryCheckoutPath.make("/workspace/review-contribution-host"),
  comparison: RevisionRangeComparison.make({
    baseRef: RepositoryComparisonRef.make("main"),
    headRef: RepositoryComparisonRef.make("HEAD"),
    baseSha: baseRevision,
    headSha: headRevision,
    mergeBaseSha: baseRevision,
  }),
})
const props = {
  projectId: ReviewProjectId.make("review-contribution-host"),
  commentNoteContext: LocalCommentNoteContext.make({ target, sourceBranch: null }),
  target,
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
      ownerRegistrationToken: new TrustedExtensionRegistrationToken(),
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

  it("disposes and remounts a contribution across same-tick registration turnover", async () => {
    const mounted = vi.fn<() => void>()
    const unmounted = vi.fn<() => void>()
    const extensionId = TrustedExtensionId.make("example.review.turnover")
    const turnoverOutput = emptyOutput("turnover")
    function TurnoverContribution() {
      useReviewDiffContributionRegistration(turnoverOutput)
      useEffect(() => {
        mounted()
        return unmounted
      }, [])
      return null
    }
    const extension: TrustedBuiltInExtension = {
      id: extensionId,
      reviewDiffContributions: [
        {
          id: TrustedExtensionContributionId.make("example.review.turnover.diff"),
          order: 100,
          component: TurnoverContribution,
        },
      ],
    }
    const registry = Result.getOrThrow(makeTrustedExtensionRegistry([reviewExtension, extension]))
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      <TrustedExtensionRegistryProvider extensions={[]} registry={registry}>
        <RegistryHarness />
      </TrustedExtensionRegistryProvider>,
    )

    await vi.waitFor(() => expect(mounted).toHaveBeenCalledOnce())
    expect(registry.unregister(extensionId)).toBe(true)
    Result.getOrThrow(registry.register(extension))

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
    ownerRegistrationToken: new TrustedExtensionRegistrationToken(),
    component: TestReviewContribution,
  }
}

const emptyOutput = (label: string): ReviewDiffContributionOutput => {
  void label
  return {
    activeLineAnchor: Option.none(),
    details: [],
    annotations: () => [],
    activateLine: () => false,
    annotationsRendered: () => undefined,
  }
}

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
      {host.outputs.map(({ id }) => (
        <span key={id} data-review-output={id.split(".").at(-1)} />
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

const RegistryHarness = () => {
  const { reviewDiffContributions } = useTrustedExtensionRegistry()
  return <Harness contributions={reviewDiffContributions} reviewProps={props} />
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
