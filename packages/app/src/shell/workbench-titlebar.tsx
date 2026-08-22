import { ArrowLeft, Keyboard, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/shared/ui/button"
import { cn } from "@/shared/utils"
import { isMacPlatform, keyboardShortcutModifierLabel } from "./keyboard-shortcut-platform"

/** Application-level window chrome shared by every renderer screen. */
export const WorkbenchTitlebar = ({
  canNavigateBack,
  commandLabel,
  commandNavigationDisabled,
  showSidebarToggle,
  sidebarExpanded,
  onNavigateBack,
  onOpenKeyboardShortcuts,
  onOpenQuickNavigation,
  onContextActionsHostChange,
  onToggleSidebar,
  aiConnectionControl,
}: {
  readonly canNavigateBack: boolean
  readonly commandLabel: string
  readonly commandNavigationDisabled: boolean
  readonly showSidebarToggle: boolean
  readonly sidebarExpanded: boolean
  readonly onNavigateBack: () => void
  readonly onOpenKeyboardShortcuts: () => void
  readonly onOpenQuickNavigation: () => void
  readonly onContextActionsHostChange: (host: HTMLDivElement | null) => void
  readonly onToggleSidebar: () => void
  readonly aiConnectionControl?: ReactNode
}) => {
  const isMac = isMacPlatform()
  const shortcutModifier = keyboardShortcutModifierLabel()
  const shortcutTitle = `Keyboard shortcuts (${shortcutModifier} + /)`
  const sidebarTitle = `${sidebarExpanded ? "Collapse" : "Expand"} sidebar (${shortcutModifier} + B)`

  return (
    <header
      data-workbench-titlebar
      className="workbench-titlebar-drag bg-shell-bevel text-shell-titlebar-fg relative z-40 flex h-shell-titlebar shrink-0 items-center"
    >
      <div
        className={cn(
          "workbench-titlebar-interactive flex items-center gap-0.5",
          isMac ? "pl-18" : "pl-2",
        )}
      >
        {showSidebarToggle ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={sidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
            aria-expanded={sidebarExpanded}
            data-workbench-sidebar-toggle
            title={sidebarTitle}
            className={cn(
              "text-shell-titlebar-muted hover:bg-shell-titlebar-control-hover hover:text-shell-titlebar-fg",
              isMac && "relative top-px left-1",
            )}
            onClick={onToggleSidebar}
          >
            {sidebarExpanded ? (
              <PanelLeftClose className="size-4" />
            ) : (
              <PanelLeftOpen className="size-4" />
            )}
          </Button>
        ) : null}
      </div>

      <div className="workbench-titlebar-interactive absolute left-1/2 -translate-x-1/2">
        {canNavigateBack ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Back"
            title="Back"
            data-workbench-back
            className="workbench-titlebar-interactive text-shell-titlebar-muted hover:bg-shell-titlebar-control-hover hover:text-shell-titlebar-fg absolute top-0 right-full mr-1"
            onClick={onNavigateBack}
          >
            <ArrowLeft className="size-4" />
          </Button>
        ) : null}
        <button
          type="button"
          data-workbench-command-center
          aria-haspopup="dialog"
          disabled={commandNavigationDisabled}
          className={cn(
            "workbench-titlebar-interactive border-shell-titlebar-border bg-shell-titlebar-control text-shell-titlebar-muted hover:bg-shell-titlebar-control-hover hover:text-shell-titlebar-fg flex h-7 w-[36rem] max-w-[42vw] min-w-64 items-center gap-2 rounded-md border px-2.5 text-xs transition-colors outline-none",
            "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
            "disabled:pointer-events-none disabled:opacity-60",
          )}
          onClick={onOpenQuickNavigation}
        >
          <Search className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-center">{commandLabel}</span>
          <kbd className="border-shell-titlebar-border bg-shell-titlebar/55 hidden shrink-0 rounded border px-1.5 py-0.5 font-sans text-[10px] sm:inline">
            {isMac ? "⌘K" : "Ctrl K"}
          </kbd>
        </button>
        <div
          ref={onContextActionsHostChange}
          data-workbench-context-actions
          className="workbench-titlebar-interactive absolute top-0 left-full ml-1 flex h-7 items-center"
        />
      </div>

      <div className="workbench-titlebar-interactive ml-auto flex items-center pr-2">
        {aiConnectionControl}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-workbench-keyboard-shortcuts
          aria-label={shortcutTitle}
          title={shortcutTitle}
          className="text-shell-titlebar-muted hover:bg-shell-titlebar-control-hover hover:text-shell-titlebar-fg"
          onClick={onOpenKeyboardShortcuts}
        >
          <Keyboard className="size-4" />
          <kbd
            data-workbench-shortcut-chord
            className="border-shell-titlebar-border bg-shell-titlebar/55 hidden rounded border px-1.5 py-0.5 font-sans text-[10px] md:inline"
          >
            {isMac ? "Cmd + /" : "Ctrl + /"}
          </kbd>
        </Button>
      </div>
    </header>
  )
}
