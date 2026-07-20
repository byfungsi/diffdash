import { ChevronDown, ChevronUp, Search, X } from "lucide-react"
import type { KeyboardEvent, RefObject } from "react"
import { Button } from "@/shared/ui/button"
import { Input } from "@/shared/ui/input"

/** Props for the review diff's keyboard-driven substring search toolbar. */
type ReviewSearchToolbarProps = {
  readonly activeIndex: number
  readonly inputRef: RefObject<HTMLInputElement | null>
  readonly matchCount: number
  readonly query: string
  readonly onClose: () => void
  readonly onNext: () => void
  readonly onPrevious: () => void
  readonly onQueryChange: (query: string) => void
}

/** Renders search controls inside the review's sticky chrome. */
export function ReviewSearchToolbar({
  activeIndex,
  inputRef,
  matchCount,
  query,
  onClose,
  onNext,
  onPrevious,
  onQueryChange,
}: ReviewSearchToolbarProps) {
  const status =
    query.length === 0
      ? "Type to search the diff"
      : matchCount === 0
        ? "No matches"
        : `${activeIndex + 1} of ${matchCount} matches`
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === "Enter") {
      event.preventDefault()
      if (event.shiftKey) onPrevious()
      else onNext()
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <div data-review-search-toolbar className="border-b px-5 py-2">
      <search
        aria-label="Search review diff"
        className="bg-card ml-auto flex h-8 w-full max-w-md items-center gap-1 rounded-lg border px-1 shadow-xs"
      >
        <Search className="text-muted-foreground ml-1 size-3.5" aria-hidden="true" />
        <Input
          ref={inputRef}
          data-review-search-input
          aria-label="Search review diff"
          className="h-7 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
          placeholder="Search diff"
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <span className="text-muted-foreground min-w-14 px-1 text-right font-mono text-caption tabular-nums">
          {query.length === 0 || matchCount === 0 ? "0 / 0" : `${activeIndex + 1} / ${matchCount}`}
        </span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Previous match"
          title="Previous match (Shift+Enter)"
          disabled={matchCount === 0}
          onClick={onPrevious}
        >
          <ChevronUp />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Next match"
          title="Next match (Enter)"
          disabled={matchCount === 0}
          onClick={onNext}
        >
          <ChevronDown />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Close search"
          title="Close search (Escape)"
          onClick={onClose}
        >
          <X />
        </Button>
      </search>
      <span className="sr-only" aria-live="polite">
        {status}
      </span>
    </div>
  )
}
