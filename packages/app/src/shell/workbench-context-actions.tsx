import { createContext, type ReactNode, useContext } from "react"
import { createPortal } from "react-dom"

const WorkbenchContextActionsHost = createContext<HTMLElement | null>(null)

/** Provides the active titlebar action host to route-local feature UI. */
export const WorkbenchContextActionsProvider = ({
  children,
  host,
}: {
  readonly children: ReactNode
  readonly host: HTMLElement | null
}) => (
  <WorkbenchContextActionsHost.Provider value={host}>
    {children}
  </WorkbenchContextActionsHost.Provider>
)

/** Renders route-local actions beside the centered workbench command field. */
export const WorkbenchContextActions = ({ children }: { readonly children: ReactNode }) => {
  const host = useContext(WorkbenchContextActionsHost)
  return host === null ? null : createPortal(children, host)
}
