import type { ProjectWorkspaceStateInput } from "@diffdash/domain/project-workspace"
import { createContext, type ReactNode, use, useState } from "react"

import { runRendererPromise, useRendererPreferences } from "@/platform/renderer-runtime"

/** One owner-generation handle into the app-scoped workspace persistence queue. */
export interface ProjectWorkspacePersistenceGeneration {
  /** Invalidates queued saves that have not started renderer persistence. */
  readonly dispose: () => void
  /** Queues a save and rechecks current ownership immediately before renderer persistence. */
  readonly save: (input: ProjectWorkspaceStateInput, isCurrent: () => boolean) => Promise<boolean>
}

/** Serializes workspace persistence across every project owner generation in one app lifetime. */
export class ProjectWorkspacePersistenceCoordinator {
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly persistWorkspace: (input: ProjectWorkspaceStateInput) => Promise<void>,
  ) {}

  /** Creates an independently invalidatable owner-generation handle sharing the app queue. */
  createGeneration(): ProjectWorkspacePersistenceGeneration {
    const state = { active: true }
    return {
      dispose: () => {
        state.active = false
      },
      save: (input, isCurrent) => {
        const requested = this.queue.then(async () => {
          if (!state.active || !isCurrent()) return false
          await this.persistWorkspace(input)
          return true
        })
        this.queue = requested.then(
          () => undefined,
          () => undefined,
        )
        return requested
      },
    }
  }
}

const ProjectWorkspacePersistenceContext =
  createContext<ProjectWorkspacePersistenceCoordinator | null>(null)

/** Mounts the stable renderer workspace persistence coordinator for the app lifetime. */
export const ProjectWorkspacePersistenceProvider = ({
  children,
}: {
  readonly children: ReactNode
}): ReactNode => {
  const preferences = useRendererPreferences()
  const [coordinator] = useState(
    () =>
      new ProjectWorkspacePersistenceCoordinator(async (input) => {
        await runRendererPromise(preferences.saveWorkspace(input))
      }),
  )
  return (
    <ProjectWorkspacePersistenceContext value={coordinator}>
      {children}
    </ProjectWorkspacePersistenceContext>
  )
}

/** Returns the app-scoped coordinator used to create project owner generations. */
export const useProjectWorkspacePersistenceCoordinator =
  (): ProjectWorkspacePersistenceCoordinator => {
    const coordinator = use(ProjectWorkspacePersistenceContext)
    if (coordinator === null) throw new Error("ProjectWorkspacePersistenceProvider is unavailable")
    return coordinator
  }
