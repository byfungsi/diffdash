import type { ProjectWorkspaceActivityId } from "@diffdash/domain/project-workspace"
import { Code2, Files, GitPullRequest, MessageSquare, Sparkles } from "lucide-react"
import type { Ref } from "react"

import type {
  ProjectActivityContribution,
  ProjectActivityIcon,
} from "@/extensions/extension-registry"
import { Button } from "@/shared/ui/button"
import { cn } from "@/shared/utils"

interface ProjectActivityNavigationProps {
  readonly activeActivity: ProjectWorkspaceActivityId
  readonly activities: readonly ProjectActivityContribution[]
  readonly buttonRefs?: ReadonlyMap<ProjectWorkspaceActivityId, Ref<HTMLButtonElement>>
  readonly placement: "rail" | "bottom"
  readonly sidebarExpanded: boolean
  readonly onSelect: (activity: ProjectActivityContribution) => void
}

const activityIcons = {
  reviews: GitPullRequest,
  files: Files,
  code: Code2,
  walkthrough: Sparkles,
  comments: MessageSquare,
} as const satisfies Readonly<Record<ProjectActivityIcon, typeof Files>>

/** Shared project activity rail used before, during, and after review loading. */
export const ProjectActivityNavigation = ({
  activeActivity,
  activities,
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
      {activities.map((activity) => {
        const Icon = activityIcons[activity.icon]
        const selected = activeActivity === activity.id
        return (
          <Button
            key={activity.id}
            ref={buttonRefs?.get(activity.id)}
            type="button"
            size="icon-lg"
            variant="ghost"
            className={cn(
              "text-shell-activity-rail-muted size-10 hover:bg-transparent hover:text-primary dark:hover:bg-transparent",
              selected && "text-primary",
            )}
            aria-label={activity.label}
            aria-pressed={selected}
            aria-expanded={selected && sidebarExpanded}
            data-project-activity-id={activity.id}
            data-project-activity-placement={placement}
            title={activity.label}
            onClick={() => {
              onSelect(activity)
              window.requestAnimationFrame(() => {
                const buttons = document.querySelectorAll<HTMLButtonElement>(
                  "[data-project-activity-id]",
                )
                Array.from(buttons)
                  .find(
                    (button) =>
                      button.dataset.projectActivityId === activity.id &&
                      button.dataset.projectActivityPlacement === placement &&
                      button.ariaPressed === "true",
                  )
                  ?.focus()
              })
            }}
          >
            <Icon className="size-6" />
            <span className="sr-only">{activity.label}</span>
          </Button>
        )
      })}
    </nav>
  </aside>
)
