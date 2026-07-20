import { Command, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { EmptyState } from "@/shared/ui/empty-state"
import { Input } from "@/shared/ui/input"

/** One searchable command-palette action. */
export type CommandPaletteItem = {
  readonly id: string
  readonly title: string
  readonly subtitle: string
  readonly keywords: string
  readonly disabled?: boolean
  readonly onSelect: () => void
}

/** Searchable keyboard and pointer command palette shared by shell and review features. */
export const CommandPaletteDialog = ({
  items,
  open,
  placeholder,
  title,
  onOpenChange,
}: {
  readonly items: readonly CommandPaletteItem[]
  readonly open: boolean
  readonly placeholder: string
  readonly title: string
  readonly onOpenChange: (open: boolean) => void
}) => {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const normalizedQuery = query.trim().toLowerCase()
  const filteredItems =
    normalizedQuery.length === 0
      ? items
      : items.filter((item) =>
          `${item.title} ${item.subtitle} ${item.keywords}`.toLowerCase().includes(normalizedQuery),
        )
  const activeItemIndex = Math.min(activeIndex, Math.max(0, filteredItems.length - 1))

  useEffect(() => {
    if (!open) {
      setQuery("")
      setActiveIndex(0)
      return
    }
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  if (!open) return null

  const runItem = (item: CommandPaletteItem) => {
    if (item.disabled) return
    item.onSelect()
    onOpenChange(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/20 px-4 pt-[12vh] backdrop-blur-sm">
      <dialog
        open
        aria-modal="true"
        aria-label={title}
        className="relative m-0 w-full max-w-2xl overflow-hidden rounded-2xl border bg-popover p-0 text-popover-foreground shadow-2xl"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            onOpenChange(false)
            return
          }
          if (event.key === "ArrowDown") {
            event.preventDefault()
            setActiveIndex((index) => Math.min(index + 1, Math.max(0, filteredItems.length - 1)))
            return
          }
          if (event.key === "ArrowUp") {
            event.preventDefault()
            setActiveIndex((index) => Math.max(0, index - 1))
            return
          }
          if (event.key === "Enter") {
            event.preventDefault()
            const item = filteredItems[activeItemIndex]
            if (item !== undefined) runItem(item)
          }
        }}
      >
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <Command className="text-muted-foreground size-4" />
          <Input
            ref={inputRef}
            value={query}
            className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
            placeholder={placeholder}
            onChange={(event) => {
              setQuery(event.currentTarget.value)
              setActiveIndex(0)
            }}
          />
          <button
            type="button"
            aria-label="Close command palette"
            className="text-muted-foreground hover:text-foreground rounded-full p-1"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="max-h-[min(28rem,60vh)] overflow-y-auto p-2">
          {filteredItems.length === 0 ? (
            <EmptyState className="m-2 p-5 text-xs">No matching commands found.</EmptyState>
          ) : null}
          {filteredItems.map((item, index) => (
            <button
              key={item.id}
              type="button"
              disabled={item.disabled}
              className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-45 ${
                activeItemIndex === index
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/70"
              }`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => runItem(item)}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{item.title}</span>
                <span className="text-muted-foreground block truncate text-xs">
                  {item.subtitle}
                </span>
              </span>
              {item.disabled ? (
                <span className="text-caption text-muted-foreground">Unavailable</span>
              ) : null}
            </button>
          ))}
        </div>
      </dialog>
    </div>
  )
}
