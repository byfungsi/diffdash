import type { ProjectWorkspaceRibbon } from "@diffdash/domain/project-workspace"
import type { ReactNode } from "react"

import { ReviewWorkbenchLayout } from "@/review/review-workbench-layout"

import { ProjectActivityNavigation } from "./project-activity-navigation"

/** Workspace chrome inputs shared by selected and unselected project states. */
export interface ProjectWorkspaceFrameProps {
  readonly activeRibbon: ProjectWorkspaceRibbon
  readonly context: ReactNode
  readonly contextWidth: number
  readonly main: ReactNode
  readonly sidebarExpanded: boolean
  readonly threadDetailWidth: number
  readonly onActiveRibbonChange: (ribbon: ProjectWorkspaceRibbon) => void
  readonly onSidebarExpandedChange: (expanded: boolean) => void
  readonly onSidebarWidthChange: (width: number) => void
  readonly onThreadDetailWidthChange: (width: number) => void
}

/** Keeps project activity and context chrome mounted for empty, loading, and failure states. */
export const ProjectWorkspaceFrame = ({
  activeRibbon,
  context,
  contextWidth,
  main,
  sidebarExpanded,
  threadDetailWidth,
  onActiveRibbonChange,
  onSidebarExpandedChange,
  onSidebarWidthChange,
  onThreadDetailWidthChange,
}: ProjectWorkspaceFrameProps) => {
  const activePane = sidebarExpanded ? "context" : "diff"

  const selectRibbon = (ribbon: ProjectWorkspaceRibbon) => {
    if (ribbon === activeRibbon && sidebarExpanded) {
      onSidebarExpandedChange(false)
      return
    }
    onActiveRibbonChange(ribbon)
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
          activeRibbon={activeRibbon}
          placement={placement}
          sidebarExpanded={sidebarExpanded && (placement === "rail" || activePane === "context")}
          onSelect={selectRibbon}
        />
      )}
      onContextCollapsedByUser={() => onSidebarExpandedChange(false)}
      onContextWidthCommit={onSidebarWidthChange}
      onDetailCollapsedByUser={() => undefined}
      onDetailWidthCommit={onThreadDetailWidthChange}
    />
  )
}
