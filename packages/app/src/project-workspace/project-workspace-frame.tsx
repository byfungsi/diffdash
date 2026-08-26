import type { ProjectWorkspaceActivityId } from "@diffdash/domain/project-workspace"
import type { ReactNode } from "react"

import type {
  OwnedExtensionContribution,
  ProjectActivityContribution,
} from "@/extensions/extension-registry"
import { ReviewWorkbenchLayout } from "@/review/review-workbench-layout"

import { ProjectActivityNavigation } from "./project-activity-navigation"

/** Workspace chrome inputs shared by selected and unselected project states. */
export interface ProjectWorkspaceFrameProps {
  readonly activeActivity: ProjectWorkspaceActivityId
  readonly activities: readonly OwnedExtensionContribution<ProjectActivityContribution>[]
  readonly context: ReactNode
  readonly contextWidth: number
  readonly main: ReactNode
  readonly preferredActivePane?: "context" | "diff"
  readonly sidebarExpanded: boolean
  readonly threadDetailWidth: number
  readonly onActiveActivityChange: (activityId: ProjectWorkspaceActivityId) => void
  readonly onSidebarExpandedChange: (expanded: boolean) => void
  readonly onSidebarWidthChange: (width: number) => void
  readonly onThreadDetailWidthChange: (width: number) => void
}

/** Keeps project activity and context chrome mounted for empty, loading, and failure states. */
export const ProjectWorkspaceFrame = ({
  activeActivity,
  activities,
  context,
  contextWidth,
  main,
  preferredActivePane,
  sidebarExpanded,
  threadDetailWidth,
  onActiveActivityChange,
  onSidebarExpandedChange,
  onSidebarWidthChange,
  onThreadDetailWidthChange,
}: ProjectWorkspaceFrameProps) => {
  const activePane = preferredActivePane ?? (sidebarExpanded ? "context" : "diff")

  const selectActivity = (activity: OwnedExtensionContribution<ProjectActivityContribution>) => {
    if (activity.id === activeActivity && sidebarExpanded) {
      onSidebarExpandedChange(false)
      return
    }
    onActiveActivityChange(activity.id)
    onSidebarExpandedChange(true)
  }

  return (
    <ReviewWorkbenchLayout
      activePane={activePane}
      context={sidebarExpanded ? context : null}
      detail={null}
      detailOpen={false}
      diff={<div className="bg-workspace-canvas h-full overflow-auto">{main}</div>}
      preferences={{ contextWidth, threadDetailWidth }}
      sidebarRequestedOpen={sidebarExpanded}
      renderActivityNavigation={(placement) => (
        <ProjectActivityNavigation
          activeActivity={activeActivity}
          activities={activities}
          placement={placement}
          sidebarExpanded={sidebarExpanded && (placement === "rail" || activePane === "context")}
          onSelect={selectActivity}
        />
      )}
      onContextCollapsedByUser={() => onSidebarExpandedChange(false)}
      onContextWidthCommit={onSidebarWidthChange}
      onDetailCollapsedByUser={() => undefined}
      onDetailWidthCommit={onThreadDetailWidthChange}
    />
  )
}
