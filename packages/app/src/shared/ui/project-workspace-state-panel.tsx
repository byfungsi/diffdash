import type { ReactNode } from "react"

import { cn } from "@/shared/utils"
import { UnicodeLoadingText } from "@/shared/ui/unicode-loading-text"

/** Visual emphasis for a project-workspace state panel. */
export type ProjectWorkspaceStatePanelTone = "neutral" | "warning" | "danger"

/** Accessible progress displayed by a project-workspace state panel. */
export interface ProjectWorkspaceStatePanelProgress {
  readonly label: string
  readonly max?: number
  readonly value?: number
}

/** Inputs for the shared project-workspace lifecycle state panel. */
export interface ProjectWorkspaceStatePanelProps {
  readonly actions?: ReactNode
  readonly announcement?: "loading" | "alert"
  readonly className?: string
  readonly description: ReactNode
  readonly progress?: ProjectWorkspaceStatePanelProgress
  readonly title: string
  readonly tone: ProjectWorkspaceStatePanelTone
}

const toneClasses: Readonly<Record<ProjectWorkspaceStatePanelTone, string>> = {
  neutral: "border-border bg-card",
  warning: "border-risk-review/40 bg-risk-review/5",
  danger: "border-destructive/40 bg-destructive/5",
}

const titleClasses: Readonly<Record<ProjectWorkspaceStatePanelTone, string>> = {
  neutral: "text-card-foreground",
  warning: "text-review-modified-text",
  danger: "text-destructive",
}

/** Compact accessible panel for non-ready project-workspace ribbon states. */
export const ProjectWorkspaceStatePanel = ({
  actions,
  announcement,
  className,
  description,
  progress,
  title,
  tone,
}: ProjectWorkspaceStatePanelProps) => {
  const loading = announcement === "loading"
  const progressMax = progress?.max ?? 100

  return (
    <section
      aria-busy={loading || undefined}
      className={cn("rounded-xl border p-4 shadow-xs", toneClasses[tone], className)}
      data-slot="project-workspace-state-panel"
      data-tone={tone}
      role={announcement === "alert" ? "alert" : undefined}
    >
      {loading ? (
        <UnicodeLoadingText
          className={cn("text-sm font-semibold", titleClasses[tone])}
          text={title}
        />
      ) : (
        <h3 className={cn("text-sm font-semibold", titleClasses[tone])}>{title}</h3>
      )}
      <div className="text-muted-foreground mt-1 text-xs leading-5">{description}</div>
      {progress === undefined ? null : (
        <div className="mt-3">
          {progress.value === undefined ? (
            <progress
              aria-label={progress.label}
              className="h-1.5 w-full overflow-hidden rounded-full accent-primary"
              max={progressMax}
            />
          ) : (
            <progress
              aria-label={progress.label}
              className="h-1.5 w-full overflow-hidden rounded-full accent-primary"
              max={progressMax}
              value={progress.value}
            />
          )}
        </div>
      )}
      {actions === undefined ? null : <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
    </section>
  )
}
