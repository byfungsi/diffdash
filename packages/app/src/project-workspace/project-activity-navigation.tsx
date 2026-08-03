import type { ProjectWorkspaceRibbon } from "@diffdash/domain/project-workspace"
import { Files, GitPullRequest, MessageSquare, Sparkles } from "lucide-react"
import type { Ref } from "react"

import { Button } from "@/shared/ui/button"
import { cn } from "@/shared/utils"

interface ProjectActivityNavigationProps {
  readonly activeRibbon: ProjectWorkspaceRibbon
  readonly buttonRefs?: Partial<Readonly<Record<ProjectWorkspaceRibbon, Ref<HTMLButtonElement>>>>
  readonly placement: "rail" | "bottom"
  readonly sidebarExpanded: boolean
  readonly onSelect: (ribbon: ProjectWorkspaceRibbon) => void
}

const activityDefinitions = {
  reviews: { label: "Reviews", icon: GitPullRequest },
  files: { label: "Files", icon: Files },
  walkthrough: { label: "Walkthrough", icon: Sparkles },
  threads: { label: "Threads", icon: MessageSquare },
} as const satisfies Readonly<
  Record<
    ProjectWorkspaceRibbon,
    {
      readonly label: string
      readonly icon: typeof Files
    }
  >
>

const activities = [
  { id: "reviews", ...activityDefinitions.reviews },
  { id: "files", ...activityDefinitions.files },
  { id: "walkthrough", ...activityDefinitions.walkthrough },
  { id: "threads", ...activityDefinitions.threads },
] as const satisfies readonly {
  readonly id: ProjectWorkspaceRibbon
  readonly label: string
  readonly icon: typeof Files
}[]

/** Shared project activity rail used before, during, and after review loading. */
export const ProjectActivityNavigation = ({
  activeRibbon,
  buttonRefs,
  placement,
  sidebarExpanded,
  onSelect,
}: ProjectActivityNavigationProps) => (
  <aside
    aria-label="Project activities"
    data-review-activity-rail
    data-review-activity-placement={placement}
    className={cn(
      "bg-shell-bevel text-shell-activity-rail-fg relative z-30 flex shrink-0",
      placement === "bottom"
        ? "order-2 h-12 w-full flex-row"
        : "order-0 h-full min-h-0 w-review-activity-rail flex-col",
    )}
  >
    <nav
      className={cn(
        "flex min-h-0 flex-1 items-center gap-2 px-1 py-1",
        placement === "bottom" ? "flex-row justify-around" : "flex-col py-2",
      )}
    >
      {activities.map(({ id, icon: Icon, label }) => (
        <Button
          key={id}
          ref={buttonRefs?.[id]}
          type="button"
          size="icon-lg"
          variant="ghost"
          className={cn(
            "text-shell-activity-rail-muted size-10 hover:bg-transparent hover:text-primary dark:hover:bg-transparent",
            activeRibbon === id && "text-primary",
          )}
          aria-label={label}
          aria-pressed={activeRibbon === id}
          aria-expanded={activeRibbon === id && sidebarExpanded}
          title={label}
          onClick={() => onSelect(id)}
        >
          <Icon className="size-6" />
          <span className="sr-only">{label}</span>
        </Button>
      ))}
    </nav>
  </aside>
)
