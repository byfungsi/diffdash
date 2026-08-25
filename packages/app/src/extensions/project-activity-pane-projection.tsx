import { createContext, type ReactNode, use } from "react"

interface ProjectActivityPaneProjection {
  readonly contextPane: ReactNode
  readonly detailPane: ReactNode
}

const ProjectActivityPaneProjectionContext = createContext<ProjectActivityPaneProjection | null>(
  null,
)

/** Supplies surface-owned pane content to registered activity slot components. */
export const ProjectActivityPaneProjectionProvider = ({
  children,
  contextPane,
  detailPane,
}: ProjectActivityPaneProjection & { readonly children: ReactNode }) => (
  <ProjectActivityPaneProjectionContext value={{ contextPane, detailPane }}>
    {children}
  </ProjectActivityPaneProjectionContext>
)

const useProjectActivityPaneProjection = (): ProjectActivityPaneProjection => {
  const projection = use(ProjectActivityPaneProjectionContext)
  if (projection === null) throw new Error("Project activity pane projection is unavailable")
  return projection
}

/** Renders context content projected through a registered activity slot. */
export const ProjectedActivityContextPane = () => useProjectActivityPaneProjection().contextPane

/** Renders detail content projected through a registered activity slot. */
export const ProjectedActivityDetailPane = () => useProjectActivityPaneProjection().detailPane

/** Renders the surface-owned main content supplied to its default main-pane contribution. */
export const ProjectedActivityMainPane = ({ baseMain }: { readonly baseMain: ReactNode }) =>
  baseMain
