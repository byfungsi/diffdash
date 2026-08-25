import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  OwnedExtensionContribution,
  ProjectActivityContribution,
  ProjectActivityMainPaneProps,
  ProjectSurfaceContribution,
} from "./extension-registry"
import {
  TrustedExtensionContributionId,
  TrustedExtensionId,
  TrustedExtensionRegistrationToken,
} from "./extension-registry"
import { resolveProjectActivityMainPane } from "./project-main-pane-resolver"
import { PROJECT_WORKSPACE_CODE_ACTIVITY_ID } from "./code/code-extension"

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

const DecoratedMain = ({ baseMain }: ProjectActivityMainPaneProps) => (
  <section data-decorated-main>
    <header>Activity decoration</header>
    {baseMain}
  </section>
)

const ReplacedMain = () => <article data-replaced-main>Replacement content</article>

const ownerExtensionId = TrustedExtensionId.make("example.resolver.extension")
const registrationToken = new TrustedExtensionRegistrationToken()

const activity: OwnedExtensionContribution<ProjectActivityContribution> = {
  ownerExtensionId,
  ownerRegistrationToken: registrationToken,
  id: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
  label: "Code",
  icon: () => null,
  order: 1,
  supportedSurfaces: ["code"],
  defaultForSurfaces: ["code"],
  surfacePolicy: "code",
  slots: {
    mainPane: {
      id: TrustedExtensionContributionId.make("example.resolver.decorated-main"),
      order: 1,
      mode: "decorate",
      component: DecoratedMain,
    },
  },
}

const surface: OwnedExtensionContribution<ProjectSurfaceContribution> = {
  ownerExtensionId,
  ownerRegistrationToken: registrationToken,
  id: TrustedExtensionContributionId.make("example.resolver.surface"),
  order: 1,
  surface: "code",
  defaultActivityId: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
  defaultMainPane: {
    id: TrustedExtensionContributionId.make("example.resolver.default-main"),
    order: 1,
    component: ({ baseMain }) => <div data-default-main>{baseMain}</div>,
  },
  component: () => null,
}

const activityWithoutMainPane: OwnedExtensionContribution<ProjectActivityContribution> = {
  ownerExtensionId,
  ownerRegistrationToken: registrationToken,
  id: activity.id,
  label: activity.label,
  icon: activity.icon,
  order: activity.order,
  supportedSurfaces: activity.supportedSurfaces,
  defaultForSurfaces: ["code"],
  surfacePolicy: activity.surfacePolicy,
}

describe("resolveProjectActivityMainPane", () => {
  it("passes the surface default main pane through a decorating activity", async () => {
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      resolveProjectActivityMainPane({
        activeActivityId: activity.id,
        activities: [activity],
        activityPaneProps: {
          location: { surface: "code", projectId: ReviewProjectId.make("project-1") },
          paneHost: {
            contextOpen: false,
            detailOpen: false,
            contextActions: null,
            openContext: () => undefined,
            openDetail: () => undefined,
            closeContext: () => undefined,
            closeDetail: () => undefined,
            showMain: () => undefined,
          },
        },
        baseMain: <main>Surface content</main>,
        surface,
      }),
    )

    await vi.waitFor(() => {
      expect(container.querySelector("[data-decorated-main]")).not.toBeNull()
      expect(container.querySelector("[data-default-main]")?.textContent).toBe("Surface content")
      expect(container.textContent).toContain("Activity decoration")
    })
  })

  it("renders the default main pane when the activity has no main slot", async () => {
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      resolveProjectActivityMainPane({
        activeActivityId: activity.id,
        activities: [activityWithoutMainPane],
        activityPaneProps: {
          location: { surface: "code", projectId: ReviewProjectId.make("project-1") },
          paneHost: {
            contextOpen: false,
            detailOpen: false,
            contextActions: null,
            openContext: () => undefined,
            openDetail: () => undefined,
            closeContext: () => undefined,
            closeDetail: () => undefined,
            showMain: () => undefined,
          },
        },
        baseMain: <main>Review list</main>,
        surface,
      }),
    )

    await vi.waitFor(() => expect(container.textContent).toBe("Review list"))
    expect(container.querySelector("[data-decorated-main]")).toBeNull()
  })

  it("replaces the surface default without rendering or passing its base", async () => {
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      resolveProjectActivityMainPane({
        activeActivityId: activity.id,
        activities: [
          {
            ...activity,
            slots: {
              mainPane: {
                id: TrustedExtensionContributionId.make("example.resolver.replaced-main"),
                order: 1,
                mode: "replace",
                component: ReplacedMain,
              },
            },
          },
        ],
        activityPaneProps: {
          location: { surface: "code", projectId: ReviewProjectId.make("project-1") },
          paneHost: {
            contextOpen: false,
            detailOpen: false,
            contextActions: null,
            openContext: () => undefined,
            openDetail: () => undefined,
            closeContext: () => undefined,
            closeDetail: () => undefined,
            showMain: () => undefined,
          },
        },
        baseMain: <main>Surface content</main>,
        surface,
      }),
    )

    await vi.waitFor(() => expect(container.querySelector("[data-replaced-main]")).not.toBeNull())
    expect(container.querySelector("[data-default-main]")).toBeNull()
    expect(container.textContent).toBe("Replacement content")
  })

  it("remounts an activity main pane across same-ID registration turnover", async () => {
    let mounts = 0
    let disposals = 0
    const StatefulMain = () => {
      useEffect(() => {
        mounts += 1
        return () => {
          disposals += 1
        }
      }, [])
      return <article>Stateful pane</article>
    }
    const render = (token: TrustedExtensionRegistrationToken) =>
      resolveProjectActivityMainPane({
        activeActivityId: activity.id,
        activities: [
          {
            ...activity,
            ownerRegistrationToken: token,
            slots: {
              mainPane: {
                id: TrustedExtensionContributionId.make("example.resolver.stateful-main"),
                order: 1,
                mode: "replace",
                component: StatefulMain,
              },
            },
          },
        ],
        activityPaneProps: {
          location: { surface: "code", projectId: ReviewProjectId.make("project-1") },
          paneHost: {
            contextOpen: false,
            detailOpen: false,
            contextActions: null,
            openContext: () => undefined,
            openDetail: () => undefined,
            closeContext: () => undefined,
            closeDetail: () => undefined,
            showMain: () => undefined,
          },
        },
        baseMain: null,
        surface,
      })
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(render(registrationToken))
    await vi.waitFor(() => expect(mounts).toBe(1))

    root.render(render(new TrustedExtensionRegistrationToken()))
    await vi.waitFor(() => expect(disposals).toBe(1))
    await vi.waitFor(() => expect(mounts).toBe(2))
  })
})
