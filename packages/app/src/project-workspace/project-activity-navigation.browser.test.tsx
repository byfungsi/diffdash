import { ProjectWorkspaceActivityId } from "@diffdash/domain/project-workspace"
import { useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"

import {
  TrustedExtensionId,
  TrustedExtensionRegistrationToken,
} from "@/extensions/extension-registry"
import { ProjectActivityNavigation } from "./project-activity-navigation"

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

it("remounts an activity button icon across same-ID registration turnover", async () => {
  let mounts = 0
  let disposals = 0
  const Icon = () => {
    useEffect(() => {
      mounts += 1
      return () => {
        disposals += 1
      }
    }, [])
    return <span>icon</span>
  }
  const activityId = ProjectWorkspaceActivityId.make("example.activity.test")
  const ownerExtensionId = TrustedExtensionId.make("example.activity.navigation")
  const activity = (ownerRegistrationToken: TrustedExtensionRegistrationToken) => ({
    id: activityId,
    label: "Test",
    icon: Icon,
    order: 1,
    supportedSurfaces: ["code" as const],
    defaultForSurfaces: ["code" as const],
    surfacePolicy: "code" as const,
    ownerExtensionId,
    ownerRegistrationToken,
  })
  const render = (token: TrustedExtensionRegistrationToken) => (
    <ProjectActivityNavigation
      activeActivity={activityId}
      activities={[activity(token)]}
      placement="rail"
      sidebarExpanded
      onSelect={() => undefined}
    />
  )
  const container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  root.render(render(new TrustedExtensionRegistrationToken()))
  await vi.waitFor(() => expect(mounts).toBe(1))

  root.render(render(new TrustedExtensionRegistrationToken()))
  await vi.waitFor(() => expect(disposals).toBe(1))
  await vi.waitFor(() => expect(mounts).toBe(2))
})
