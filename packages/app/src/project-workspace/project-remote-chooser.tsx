import type { ProjectRemoteSelectionRequired } from "@diffdash/domain/project-workspace"
import { GitFork, X } from "lucide-react"
import { useEffect, useRef } from "react"

import { Button } from "@/shared/ui/button"

/** Accessible chooser shown when a local project has multiple recognized hosted remotes. */
export const ProjectRemoteChooser = ({
  selection,
  onCancel,
  onSelect,
}: {
  readonly selection: ProjectRemoteSelectionRequired
  readonly onCancel: () => void
  readonly onSelect: (candidate: ProjectRemoteSelectionRequired["candidates"][number]) => void
}) => {
  const firstCandidateRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    window.requestAnimationFrame(() => firstCandidateRef.current?.focus())
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/20 px-4 pt-[12vh] backdrop-blur-sm">
      <dialog
        open
        aria-modal="true"
        aria-labelledby="project-remote-chooser-title"
        className="relative m-0 w-full max-w-xl overflow-hidden rounded-2xl border bg-popover p-0 text-popover-foreground shadow-2xl"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.preventDefault()
          onCancel()
        }}
      >
        <header className="flex items-start gap-3 border-b px-5 py-4">
          <GitFork className="text-primary mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <h2 id="project-remote-chooser-title" className="text-sm font-semibold">
              Choose the project remote
            </h2>
            <p className="text-muted-foreground mt-1 text-xs leading-5">
              This checkout has multiple recognized remotes. Choose the hosted identity DiffDash
              should use for reviews.
            </p>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Cancel opening project"
            onClick={onCancel}
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="space-y-2 p-3">
          {selection.candidates.map((candidate, index) => (
            <button
              key={`${candidate.remoteName}:${candidate.repository.providerId}:${candidate.repository.namespace}/${candidate.repository.name}`}
              ref={index === 0 ? firstCandidateRef : undefined}
              type="button"
              className="border-border-subtle bg-surface-inset hover:border-border hover:bg-surface-hover flex w-full items-center justify-between gap-4 rounded-xl border p-3 text-left transition-colors"
              onClick={() => onSelect(candidate)}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {candidate.repository.namespace}/{candidate.repository.name}
                </span>
                <span className="text-muted-foreground mt-0.5 block truncate text-xs">
                  {candidate.remoteName} · {candidate.repository.providerId}
                </span>
              </span>
              <span className="text-caption text-muted-foreground shrink-0">Use remote</span>
            </button>
          ))}
        </div>
      </dialog>
    </div>
  )
}
