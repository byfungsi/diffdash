import type { ProjectWorkspaceActivityId } from "@diffdash/domain/project-workspace"
import { Menu, X } from "lucide-react"
import { Button } from "@/shared/ui/button"
import { PROJECT_WORKSPACE_FILES_ACTIVITY_ID } from "./review-identities"

/** Review-owned mobile file-tree action, keeping activity identity policy outside the diff host. */
export const ReviewMobileFileTreeButton = ({
  activeActivity,
  contextOpen,
  showContext,
  showMain,
}: {
  readonly activeActivity: ProjectWorkspaceActivityId
  readonly contextOpen: boolean
  readonly showContext: (activity: ProjectWorkspaceActivityId) => void
  readonly showMain: () => void
}) => {
  const open = contextOpen && activeActivity === PROJECT_WORKSPACE_FILES_ACTIVITY_ID
  return (
    <Button
      variant="ghost"
      size="icon"
      className="order-first size-10 md:hidden"
      aria-label={open ? "Close file tree" : "Open file tree"}
      aria-expanded={open}
      onClick={() => (open ? showMain() : showContext(PROJECT_WORKSPACE_FILES_ACTIVITY_ID))}
    >
      {open ? <X className="size-5" /> : <Menu className="size-5" />}
    </Button>
  )
}
