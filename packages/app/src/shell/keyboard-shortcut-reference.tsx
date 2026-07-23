import { Keyboard, X } from "lucide-react"
import { useEffect, useRef } from "react"
import { Button } from "@/shared/ui/button"

type ShortcutToken = "mod" | "shift" | "enter" | "escape" | "slash" | "f" | "g" | "k" | "v"

type ShortcutEntry = {
  readonly label: string
  readonly keys: readonly (readonly ShortcutToken[])[]
}

type ShortcutSection = {
  readonly label: string
  readonly shortcuts: readonly ShortcutEntry[]
}

const SHORTCUT_SECTIONS: readonly ShortcutSection[] = [
  {
    label: "General",
    shortcuts: [
      { label: "Keyboard shortcuts", keys: [["mod", "slash"]] },
      { label: "Go anywhere", keys: [["mod", "k"]] },
    ],
  },
  {
    label: "Review",
    shortcuts: [
      { label: "Review actions", keys: [["mod", "shift", "k"]] },
      { label: "Toggle viewed file", keys: [["v"]] },
    ],
  },
  {
    label: "Review Search",
    shortcuts: [
      { label: "Search review", keys: [["mod", "f"]] },
      { label: "Next match", keys: [["mod", "g"], ["enter"]] },
      {
        label: "Previous match",
        keys: [
          ["mod", "shift", "g"],
          ["shift", "enter"],
        ],
      },
      { label: "Close search", keys: [["escape"]] },
    ],
  },
  {
    label: "Comments",
    shortcuts: [{ label: "Submit comment", keys: [["mod", "enter"]] }],
  },
]

const TOKEN_LABELS: Readonly<Record<Exclude<ShortcutToken, "mod">, string>> = {
  enter: "Enter",
  escape: "Esc",
  f: "F",
  g: "G",
  k: "K",
  shift: "Shift",
  slash: "/",
  v: "V",
}

/** Displays the application-wide catalog of supported keyboard shortcuts. */
export function KeyboardShortcutReference({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const wasOpenRef = useRef(false)
  const modifierLabel = isMacPlatform() ? "Cmd" : "Ctrl"

  useEffect(() => {
    if (open) {
      if (!wasOpenRef.current) {
        previousFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null
      }
      wasOpenRef.current = true
      const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())
      return () => window.cancelAnimationFrame(frame)
    }

    if (!wasOpenRef.current) return undefined
    wasOpenRef.current = false
    const previousFocus = previousFocusRef.current
    previousFocusRef.current = null
    const frame = window.requestAnimationFrame(() => {
      if (previousFocus?.isConnected) previousFocus.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 p-3 backdrop-blur-sm sm:p-6">
      <dialog
        open
        aria-modal="true"
        aria-labelledby="keyboard-shortcut-reference-title"
        className="bg-popover text-popover-foreground relative m-0 flex max-h-[calc(100vh-1.5rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border p-0 shadow-2xl sm:max-h-[calc(100vh-3rem)]"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.preventDefault()
          event.stopPropagation()
          onOpenChange(false)
        }}
      >
        <header className="flex items-start justify-between gap-4 border-b px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-start gap-3">
            <span className="bg-accent text-accent-foreground mt-0.5 rounded-lg p-2">
              <Keyboard className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 id="keyboard-shortcut-reference-title" className="text-base font-semibold">
                Keyboard shortcuts
              </h2>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Work across DiffDash without leaving the keyboard.
              </p>
            </div>
          </div>
          <Button
            ref={closeButtonRef}
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Close keyboard shortcuts"
            onClick={() => onOpenChange(false)}
          >
            <X />
          </Button>
        </header>
        <div className="grid min-h-0 overflow-y-auto sm:grid-cols-2">
          {SHORTCUT_SECTIONS.map((section) => (
            <section
              key={section.label}
              className="border-b p-4 last:border-b-0 sm:p-6 sm:odd:border-r"
            >
              <h3 className="text-muted-foreground mb-3 text-xs font-semibold tracking-wide uppercase">
                {section.label}
              </h3>
              <dl className="space-y-3">
                {section.shortcuts.map((shortcut) => (
                  <div key={shortcut.label} className="flex items-center justify-between gap-4">
                    <dt className="text-sm">{shortcut.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1.5">
                      {shortcut.keys.map((keys, index) => (
                        <span key={keys.join("+")} className="flex items-center gap-1">
                          {index === 0 ? null : (
                            <span className="text-muted-foreground text-caption">or</span>
                          )}
                          {keys.map((key) => (
                            <kbd
                              key={key}
                              className="bg-muted text-muted-foreground min-w-6 rounded-md border px-1.5 py-1 text-center font-mono text-caption font-medium shadow-xs"
                            >
                              {key === "mod" ? modifierLabel : TOKEN_LABELS[key]}
                            </kbd>
                          ))}
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </dialog>
    </div>
  )
}

const isMacPlatform = () => /Mac|iPhone|iPad|iPod/i.test(window.navigator.platform)
