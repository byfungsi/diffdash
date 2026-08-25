import {
  makeHostedRepositoryLocator,
  makeHostedReviewLocator,
  HostedRepositorySource,
} from "@diffdash/domain/git-provider"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { ProjectWorkspaceActivityId } from "@diffdash/domain/project-workspace"
import { Option, Result } from "effect"
import { useEffect, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { reviewExtension } from "./review/review-extension"
import {
  REVIEW_NAVIGATION_ID,
  encodeReviewNavigationState,
  useReviewNavigationController,
} from "./review/review-navigation"
import { TrustedExtensionRegistryProvider } from "./extension-registry-context"
import { makeTrustedExtensionRegistry, TrustedExtensionId } from "./extension-registry"
import {
  ProjectNavigationRuntimeProvider,
  RegisteredProjectNavigationProviders,
  useProjectNavigationRuntime,
} from "./project-navigation-runtime"

const repo = Repo.make({
  createdAt: "2026-08-24T00:00:00Z",
  id: ReviewProjectId.make("navigation-runtime-test"),
  isFavorite: false,
  lastOpenedAt: null,
  lastSyncedAt: null,
  source: HostedRepositorySource.make({
    locator: makeHostedRepositoryLocator("github", "fungsi", "diffdash"),
  }),
  checkout: LinkedCheckout.make({
    remoteUrl: "https://github.com/fungsi/diffdash",
    path: RepositoryCheckoutPath.make("/workspace/diffdash"),
  }),
  updatedAt: "2026-08-24T00:00:00Z",
})

const TEST_ACTIVITY_ID = ProjectWorkspaceActivityId.make("example.navigation.test-activity")
const TEST_ACTIVITY_EXTENSION_ID = TrustedExtensionId.make("example.navigation.test-extension")
const testActivityExtension = {
  id: TEST_ACTIVITY_EXTENSION_ID,
  projectActivities: [
    {
      id: TEST_ACTIVITY_ID,
      label: "Test activity",
      icon: () => null,
      order: 1,
      supportedSurfaces: ["review" as const],
      surfacePolicy: "review" as const,
    },
  ],
}

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

describe("project navigation runtime", () => {
  it("rejects stale activity restoration across synchronous registration turnover without remounting", async () => {
    const registry = Result.getOrThrow(
      makeTrustedExtensionRegistry([reviewExtension, testActivityExtension]),
    )
    const registrationToken = registry.snapshot().projectNavigation[0]?.ownerRegistrationToken
    const activityRegistrationToken = registry
      .snapshot()
      .projectActivities.find(({ id }) => id === TEST_ACTIVITY_ID)?.ownerRegistrationToken
    if (registrationToken === undefined)
      throw new Error("Review navigation registration is unavailable")
    if (activityRegistrationToken === undefined)
      throw new Error("Review activity registration is unavailable")
    let harnessMounts = 0
    const selection = {
      kind: "hosted" as const,
      review: makeHostedReviewLocator("github", "fungsi", "diffdash", 101),
    }
    const Harness = () => {
      const runtime = useProjectNavigationRuntime()
      const reviewNavigation = useReviewNavigationController()
      const [restored, setRestored] = useState<boolean | null>(null)
      useEffect(() => {
        harnessMounts += 1
      }, [])
      return (
        <>
          <button
            data-action="restore"
            type="button"
            onClick={() =>
              setRestored(
                runtime.restore({
                  kind: "project",
                  contributionId: REVIEW_NAVIGATION_ID,
                  registrationToken,
                  activityId: TEST_ACTIVITY_ID,
                  activityRegistrationToken,
                  surface: "review",
                  repo,
                  state: encodeReviewNavigationState({ selectedReview: Option.some(selection) }),
                }),
              )
            }
          >
            Restore
          </button>
          <button
            data-action="select"
            type="button"
            onClick={() => reviewNavigation.selectReview(Option.none())}
          >
            Select
          </button>
          <output>{`${restored ?? "none"}:${Option.match(reviewNavigation.selectedReview, { onNone: () => "none", onSome: ({ kind }) => kind })}`}</output>
        </>
      )
    }
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      <TrustedExtensionRegistryProvider extensions={[]} registry={registry}>
        <ProjectNavigationRuntimeProvider>
          <RegisteredProjectNavigationProviders>
            <Harness />
          </RegisteredProjectNavigationProviders>
        </ProjectNavigationRuntimeProvider>
      </TrustedExtensionRegistryProvider>,
    )

    await vi.waitFor(() => expect(container.querySelector("[data-action=restore]")).not.toBeNull())
    container.querySelector<HTMLButtonElement>("[data-action=restore]")?.click()
    await vi.waitFor(() =>
      expect(container.querySelector("output")?.textContent).toBe("true:hosted"),
    )

    expect(registry.unregister(TEST_ACTIVITY_EXTENSION_ID)).toBe(true)
    Result.getOrThrow(registry.register(testActivityExtension))
    container.querySelector<HTMLButtonElement>("[data-action=select]")?.click()
    await vi.waitFor(() => expect(container.querySelector("output")?.textContent).toBe("true:none"))
    container.querySelector<HTMLButtonElement>("[data-action=restore]")?.click()
    await vi.waitFor(() =>
      expect(container.querySelector("output")?.textContent).toBe("false:none"),
    )
    expect(harnessMounts).toBe(1)
  })
})
