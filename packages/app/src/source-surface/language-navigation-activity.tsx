import { Loader2 } from "lucide-react"

import { WorkbenchContextActions } from "@/shell/workbench-context-actions"

/** Renders generic source-navigation activity beside the workbench search field. */
export const LanguageNavigationActivity = ({ pending }: { readonly pending: boolean }) => {
  if (!pending) return null

  return (
    <WorkbenchContextActions>
      <output
        aria-label="Loading code navigation"
        className="flex size-7 items-center justify-center text-shell-titlebar-muted"
      >
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
      </output>
    </WorkbenchContextActions>
  )
}
