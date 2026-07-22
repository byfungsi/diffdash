import type { ParsedDiffFile } from "@diffdash/domain/diff"
import { reviewPathBasename } from "@diffdash/domain/review-path"
import {
  flattenWalkthroughStops,
  focusFilesForWalkthroughHunks,
  type StoredWalkthrough,
  summarizeWalkthroughHunksByPath,
  type Walkthrough,
  type WalkthroughHunkDigest,
  type WalkthroughRisk,
} from "@diffdash/domain/walkthrough"
import { Check, Copy, FolderGit2, GitBranch, GitPullRequest, Sparkles, Star } from "lucide-react"
import { stableStringHash32 } from "@/shared/stable-string-hash"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { UnicodeLoadingText } from "@/shared/ui/unicode-loading-text"

/** Walkthrough loading and generation state. */
export type WalkthroughState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly message: string }
  | { readonly status: "ready"; readonly stored: StoredWalkthrough }
  | { readonly status: "error"; readonly message: string }

/** Flattened walkthrough step used by review navigation and palettes. */
export type WalkthroughReviewStep = {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly risk: WalkthroughRisk
  readonly hunkIds: readonly string[]
  readonly chapterTitle: string | null
}

type WalkthroughStepGroup = {
  readonly title: string
  readonly steps: readonly { readonly index: number; readonly step: WalkthroughReviewStep }[]
}

/** Walkthrough chapter and file navigation rendered in the review sidebar. */
export const WalkthroughSidebar = ({
  activeStepIndex,
  changedFiles,
  hunkDigest,
  scope,
  state,
  visitedStepIndexes,
  viewedFileKeys,
  onRegenerate,
  onRetry,
  onSelectFile,
  onSelectStep,
}: {
  readonly activeStepIndex: number
  readonly changedFiles: readonly ParsedDiffFile[]
  readonly hunkDigest: readonly WalkthroughHunkDigest[]
  readonly scope: string
  readonly state: WalkthroughState
  readonly visitedStepIndexes: ReadonlySet<number>
  readonly viewedFileKeys: ReadonlySet<string>
  readonly onRegenerate: () => void
  readonly onRetry: () => void
  readonly onSelectFile: (stepIndex: number, file: ParsedDiffFile) => void
  readonly onSelectStep: (index: number) => void
}) => {
  if (state.status === "loading") {
    return (
      <UnicodeLoadingText
        className="text-review-sidebar-muted px-3 py-2 text-xs"
        text={state.message}
      />
    )
  }
  if (state.status === "error") {
    return <WalkthroughErrorNotice message={state.message} variant="sidebar" onRetry={onRetry} />
  }
  if (state.status !== "ready") {
    return <SidebarMessage title="Walkthrough" message="Preparing walkthrough generation..." />
  }

  const steps = walkthroughReviewSteps(state.stored.walkthrough)
  const generation = state.stored.walkthrough.generation
  return (
    <div className="space-y-4 px-3 py-2 text-xs">
      <div className="space-y-1.5">
        <div className="text-review-sidebar-fg font-semibold tracking-wide uppercase">
          Review focus
        </div>
        <p className="text-review-sidebar-muted leading-5">{state.stored.walkthrough.summary}</p>
      </div>
      {generation?.mode === "sampled-tree" ? (
        <div
          data-sampled-walkthrough-notice
          className="border-review-sidebar-divider bg-review-sidebar-control rounded-xl border px-3 py-2.5"
        >
          <div className="text-review-sidebar-fg font-semibold">Sampled walkthrough</div>
          <p className="text-review-sidebar-muted mt-1 leading-5">
            This review is unusually large. DiffDash analyzed{" "}
            {generation.analyzedFiles.toLocaleString()} of {generation.totalFiles.toLocaleString()}{" "}
            changed files across {generation.analyzedFolders.toLocaleString()} of{" "}
            {generation.totalFolders.toLocaleString()} folders. Use the file tree to inspect every
            change.
          </p>
        </div>
      ) : null}
      <div className="border-review-sidebar-divider border-t pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-review-sidebar-fg font-semibold tracking-wide uppercase">Scope</div>
          <button
            type="button"
            className="text-review-sidebar-muted hover:text-review-sidebar-fg text-caption font-medium"
            onClick={onRegenerate}
          >
            Regenerate
          </button>
        </div>
        <div className="space-y-4">
          {groupWalkthroughSteps(steps).map((group) => {
            const SectionIcon = walkthroughSectionIcon(group.title)
            return (
              <section key={group.title} className="space-y-2">
                <div className="text-review-sidebar-fg flex items-center gap-2 px-1 font-semibold tracking-wide uppercase">
                  <SectionIcon className="text-review-sidebar-muted size-3.5" />
                  <span>{group.title}</span>
                </div>
                <ol className="relative space-y-1 pl-4 before:absolute before:top-[10px] before:bottom-2 before:left-[6px] before:w-px before:bg-review-sidebar-divider">
                  {group.steps.map(({ index, step }) => {
                    const files = focusFilesForWalkthroughHunks(changedFiles, step.hunkIds, scope)
                    const fileSummaries = summarizeWalkthroughHunksByPath(hunkDigest, step.hunkIds)
                    const complete =
                      files.length > 0 && files.every((file) => viewedFileKeys.has(file.reviewKey))
                    const visited = visitedStepIndexes.has(index) || complete
                    const additions = fileSummaries.reduce(
                      (total, file) => total + file.additions,
                      0,
                    )
                    const deletions = fileSummaries.reduce(
                      (total, file) => total + file.deletions,
                      0,
                    )
                    const selected = activeStepIndex === index
                    return (
                      <li key={`${index}:${step.id}`} className="relative">
                        <span
                          className={`absolute top-[10px] -left-[17px] z-10 flex size-3.5 items-center justify-center rounded-full border text-[9px] ${visited ? "border-review-success bg-review-success text-review-success-foreground" : selected ? "border-primary bg-walkthrough-marker-surface text-primary shadow-[0_0_0_3px_var(--color-review-sidebar)]" : "border-primary/70 bg-walkthrough-marker-surface text-primary"}`}
                        >
                          {visited ? <Check className="size-2.5" /> : null}
                        </span>
                        <div
                          className={`w-full rounded-xl border px-2.5 py-2 text-left transition ${selected ? "border-primary bg-review-tree-selected text-review-sidebar-emphasis" : "border-transparent text-review-sidebar-fg hover:bg-review-sidebar-control-hover"}`}
                        >
                          <button
                            type="button"
                            aria-label={`Select walkthrough step ${index + 1}: ${step.title}`}
                            className="w-full text-left"
                            onClick={() => onSelectStep(index)}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold">
                                {index + 1} {step.title}
                              </span>
                              <span className="text-caption text-review-sidebar-muted">
                                {complete
                                  ? "Done"
                                  : `${fileSummaries.length} file${fileSummaries.length === 1 ? "" : "s"}`}
                              </span>
                            </div>
                          </button>
                          <div className="text-review-sidebar-muted mt-1 space-y-0.5">
                            {fileSummaries.length === 0 ? (
                              <div className="text-caption border-review-sidebar-divider rounded-lg border px-2 py-1.5">
                                Referenced files are unavailable in this diff.
                              </div>
                            ) : (
                              fileSummaries.map((file) => {
                                const targetFile = files.find(
                                  (candidate) => candidate.path === file.path,
                                )
                                return (
                                  <button
                                    key={file.path}
                                    type="button"
                                    aria-label={`Open walkthrough file ${file.path}`}
                                    className="hover:bg-review-sidebar-control-hover disabled:text-review-sidebar-muted/70 flex w-full items-center justify-between gap-2 rounded-md px-1 py-0.5 text-left transition disabled:cursor-not-allowed"
                                    data-walkthrough-file-path={file.path}
                                    data-walkthrough-step-index={index}
                                    disabled={targetFile === undefined}
                                    title={
                                      targetFile === undefined
                                        ? `${file.path} is not available in this diff.`
                                        : file.path
                                    }
                                    onClick={() => {
                                      if (targetFile !== undefined) onSelectFile(index, targetFile)
                                    }}
                                  >
                                    <span className="truncate font-mono" title={file.path}>
                                      {reviewPathBasename(file.path)}
                                    </span>
                                    <span className="shrink-0">
                                      <span className="text-review-success">+{file.additions}</span>{" "}
                                      <span className="text-review-danger">-{file.deletions}</span>
                                    </span>
                                  </button>
                                )
                              })
                            )}
                          </div>
                          <div className="text-caption mt-1 text-right">
                            <span className="text-review-success">+{additions}</span>{" "}
                            <span className="text-review-danger">-{deletions}</span>
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ol>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** Active walkthrough step header rendered above focused diffs. */
export const WalkthroughMainHeader = ({
  activeStepComplete,
  step,
  state,
  onMarkComplete,
  onNextStep,
  onRetry,
}: {
  readonly activeStepComplete: boolean
  readonly step: WalkthroughReviewStep | null
  readonly state: WalkthroughState
  readonly onMarkComplete: () => void
  readonly onNextStep: () => void
  readonly onRetry: () => void
}) => {
  if (state.status === "loading")
    return <UnicodeLoadingText className="text-muted-foreground text-sm" text={state.message} />
  if (state.status === "error")
    return <WalkthroughErrorNotice message={state.message} variant="main" onRetry={onRetry} />
  if (state.status !== "ready" || step === null) return null
  return (
    <section className="bg-card border-l-primary rounded-2xl border border-l-4 p-5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <RiskBadge risk={step.risk} />
          <h2 className="text-2xl font-semibold tracking-tight">{step.title}</h2>
          <p className="text-muted-foreground max-w-3xl leading-6">{step.summary}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onMarkComplete}
            disabled={activeStepComplete}
          >
            {activeStepComplete ? "Complete" : "Mark complete"}
          </Button>
          <Button size="sm" variant="secondary" onClick={onNextStep}>
            Next step
          </Button>
        </div>
      </div>
    </section>
  )
}

/** Flattens walkthrough chapters and support items into review navigation steps. */
export const walkthroughReviewSteps = (
  walkthrough: Walkthrough,
): readonly WalkthroughReviewStep[] => [
  ...flattenWalkthroughStops(walkthrough).map(({ chapter, stop }) => ({
    id: `${chapter.id}:${stop.id}`,
    title: stop.title,
    summary: stop.summary,
    risk: stop.risk,
    hunkIds: stop.hunkIds,
    chapterTitle: chapter.title,
  })),
  ...walkthrough.support.map((item) => ({
    id: `support:${item.id}`,
    title: item.title,
    summary: item.reason,
    risk: "support" as const,
    hunkIds: item.hunkIds,
    chapterTitle: "Support",
  })),
]

const SidebarMessage = ({
  message,
  title,
}: {
  readonly message: string
  readonly title: string
}) => (
  <div className="space-y-3 px-3 py-2 text-xs">
    <div className="border-review-sidebar-divider rounded-xl border p-3">
      <div className="text-review-sidebar-fg font-semibold">{title}</div>
      <div className="text-review-sidebar-muted mt-1 leading-5">{message}</div>
    </div>
  </div>
)

const WalkthroughErrorNotice = ({
  message,
  variant,
  onRetry,
}: {
  readonly message: string
  readonly variant: "main" | "sidebar"
  readonly onRetry: () => void
}) => {
  const copyError = () => {
    void navigator.clipboard.writeText(message).catch(() => undefined)
  }
  return (
    <section
      className={
        variant === "sidebar"
          ? "space-y-2 px-3 py-2 text-xs"
          : "bg-card rounded-2xl border p-4 text-sm shadow-xs"
      }
    >
      <div
        className={variant === "sidebar" ? "text-review-sidebar-fg font-semibold" : "font-semibold"}
      >
        Walkthrough unavailable
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <div
          className={
            variant === "sidebar"
              ? "text-review-sidebar-muted min-w-0 flex-1 truncate"
              : "text-muted-foreground min-w-0 flex-1 truncate"
          }
          title={message}
        >
          {message}
        </div>
        <Button size="sm" variant="secondary" className="h-8 shrink-0 rounded-lg" onClick={onRetry}>
          Retry
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-foreground hover:text-foreground h-8 shrink-0 gap-1 rounded-lg"
          onClick={copyError}
        >
          <Copy className="size-3" />
          Copy error
        </Button>
      </div>
    </section>
  )
}

const RiskBadge = ({ risk }: { readonly risk: WalkthroughRisk }) => {
  const className =
    risk === "critical"
      ? "border-risk-critical/30 bg-risk-critical/10 text-risk-critical"
      : risk === "review"
        ? "border-risk-review/30 bg-risk-review/10 text-risk-review"
        : "border-risk-support/30 bg-risk-support/10 text-risk-support"
  return (
    <Badge variant="outline" className={`text-caption uppercase tracking-[0.18em] ${className}`}>
      {risk.toUpperCase()}
    </Badge>
  )
}

const WALKTHROUGH_SECTION_ICONS = [GitBranch, GitPullRequest, Sparkles, FolderGit2, Star] as const

const groupWalkthroughSteps = (
  steps: readonly WalkthroughReviewStep[],
): readonly WalkthroughStepGroup[] => {
  const groups: WalkthroughStepGroup[] = []
  const groupIndexes = new Map<string, number>()
  steps.forEach((step, index) => {
    const title = step.chapterTitle ?? "Review"
    const groupIndex = groupIndexes.get(title)
    if (groupIndex === undefined) {
      groupIndexes.set(title, groups.length)
      groups.push({ title, steps: [{ index, step }] })
      return
    }
    const group = groups[groupIndex]
    if (group !== undefined)
      groups[groupIndex] = { ...group, steps: [...group.steps, { index, step }] }
  })
  return groups
}

const walkthroughSectionIcon = (title: string) => {
  const hash = stableStringHash32(title)
  return WALKTHROUGH_SECTION_ICONS[hash % WALKTHROUGH_SECTION_ICONS.length] ?? Sparkles
}
