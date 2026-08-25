import { HashSet, Match, Option } from "effect"
import { RefreshCw } from "lucide-react"
import { useEffect, useEffectEvent } from "react"

import {
  agentSelection,
  agentUnavailableReason,
  aiProviderLabel,
  selectedAIModelLabel,
} from "@/settings/agent-selection"
import { Button } from "@/shared/ui/button"
import { Input } from "@/shared/ui/input"
import { WalkthroughMainHeader, WalkthroughSidebar } from "@/walkthrough/walkthrough-panel"
import type { ProjectActivityMainPaneProps } from "../extension-registry"
import { useReviewSurfaceCapability } from "../review/review-surface-capability"
import { useWalkthroughReviewCapability } from "./walkthrough-review-provider"
import { WalkthroughSettingsMenu } from "./walkthrough-settings-menu"

const CODING_AGENT_SETUP_MESSAGE =
  "Walkthroughs require an available agent provider. Complete provider setup to enable guided review."

/** Walkthrough-owned Review context pane. */
export const WalkthroughContextPane = () => {
  const walkthrough = useWalkthroughReviewCapability()
  const review = useReviewSurfaceCapability()
  const loadWalkthrough = useEffectEvent(() => walkthrough?.load(false))
  const shouldLoadWalkthrough = Option.match(Option.fromNullishOr(walkthrough), {
    onNone: () => false,
    onSome: ({ state }) =>
      Match.value(state).pipe(
        Match.discriminatorsExhaustive("status")({
          idle: () => true,
          loading: () => false,
          ready: () => false,
          empty: () => false,
          unavailable: () => false,
          error: () => false,
        }),
      ),
  })
  useEffect(() => {
    if (shouldLoadWalkthrough) void loadWalkthrough()
  }, [shouldLoadWalkthrough])
  if (walkthrough === null || Option.isNone(review)) return null
  const reviewCapability = review.value
  const walkthroughLoading = Match.value(walkthrough.state).pipe(
    Match.discriminatorsExhaustive("status")({
      idle: () => false,
      loading: () => true,
      ready: () => false,
      empty: () => false,
      unavailable: () => false,
      error: () => false,
    }),
  )
  const projection = walkthrough.project()
  const hiddenFileCount = reviewCapability.inventory.length - projection.activeStepInventory.length
  const totalAdditions = reviewCapability.inventory.reduce(
    (total, file) => total + file.additions,
    0,
  )
  const totalDeletions = reviewCapability.inventory.reduce(
    (total, file) => total + file.deletions,
    0,
  )
  const unavailableReason = agentUnavailableReason(
    agentSelection(walkthrough.settings, "walkthrough"),
    walkthrough.providerCatalog,
    "walkthrough",
  )

  return (
    <aside
      data-walkthrough-context-pane
      data-review-context-panel
      className="bg-review-sidebar text-review-sidebar-fg relative z-20 flex h-full min-h-0 min-w-0 flex-col"
    >
      <header
        data-review-context-header
        className="border-review-sidebar-divider flex h-9 shrink-0 items-center gap-2 border-b px-3"
      >
        <h2 className="text-caption min-w-0 flex-1 truncate font-semibold tracking-wide uppercase">
          Walkthrough
        </h2>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh walkthrough"
          title="Refresh walkthrough"
          className="text-review-sidebar-muted hover:bg-review-sidebar-control-hover hover:text-review-sidebar-fg"
          disabled={walkthroughLoading}
          onClick={() => void walkthrough.load(true)}
        >
          <RefreshCw className={`size-3 ${walkthroughLoading ? "animate-spin" : ""}`} />
        </Button>
        <WalkthroughSettingsMenu
          catalog={walkthrough.providerCatalog}
          settings={walkthrough.settings}
          onChange={walkthrough.onSettingsChange}
        />
      </header>
      <div className="bg-review-sidebar-control/20 space-y-2 p-3">
        <Input
          value={walkthrough.fileFilter}
          onChange={(event) => walkthrough.setFileFilter(event.currentTarget.value)}
          className="border-review-sidebar-divider bg-review-sidebar-control text-review-sidebar-fg placeholder:text-review-sidebar-muted h-8 text-xs"
          placeholder="Filter files"
        />
        <div className="text-caption text-review-sidebar-muted min-w-0 truncate">
          {aiProviderLabel(
            agentSelection(walkthrough.settings, "walkthrough"),
            walkthrough.providerCatalog,
          )}{" "}
          / {selectedAIModelLabel(walkthrough.settings, walkthrough.providerCatalog)}
        </div>
        {!walkthrough.aiAgentAvailable ? (
          <p className="text-caption text-review-sidebar-muted leading-4">
            {CODING_AGENT_SETUP_MESSAGE}
          </p>
        ) : null}
        {unavailableReason === null ? null : (
          <p className="text-caption text-review-sidebar-muted leading-4">{unavailableReason}</p>
        )}
      </div>
      <div
        data-walkthrough-operation-id={Option.getOrUndefined(walkthrough.operationId)}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2 pr-1"
      >
        <WalkthroughSidebar
          activeStepIndex={walkthrough.activeStepIndex}
          changedFiles={reviewCapability.parsedFiles}
          hunkDigest={projection.hunkDigest}
          scope={projection.scope}
          state={walkthrough.state}
          visitedStepIndexes={walkthrough.visitedStepIndexes}
          viewedFileKeys={reviewCapability.viewedFileKeys}
          onRegenerate={() => void walkthrough.load(true)}
          onRetry={() => void walkthrough.load(false)}
          onSelectFile={walkthrough.selectFile}
          onSelectStep={walkthrough.selectStep}
        />
      </div>
      <div className="border-review-sidebar-divider bg-review-sidebar-control text-review-sidebar-muted flex items-center justify-between gap-2 border-t px-3 py-2 text-xs">
        <span>{hiddenFileCount > 0 ? `${hiddenFileCount} outside step` : "Total"}</span>
        <span>
          <span className="text-review-success-text">+{totalAdditions}</span>{" "}
          <span className="text-review-danger-text">-{totalDeletions}</span>
        </span>
      </div>
    </aside>
  )
}

/** Walkthrough-owned decoration above Review's focused diffs. */
export const WalkthroughMainPane = ({ baseMain }: ProjectActivityMainPaneProps) => {
  const walkthrough = useWalkthroughReviewCapability()
  const review = useReviewSurfaceCapability()
  if (walkthrough === null || Option.isNone(review)) return baseMain
  const projection = walkthrough.project()
  const activeStepComplete = Option.exists(
    projection.activeStep,
    () =>
      projection.activeStepFiles.length > 0 &&
      projection.activeStepFiles.every((file) =>
        HashSet.has(review.value.viewedFileKeys, file.reviewKey),
      ),
  )
  return (
    <>
      <WalkthroughMainHeader
        activeStepComplete={activeStepComplete}
        step={Option.getOrNull(projection.activeStep)}
        state={walkthrough.state}
        onMarkComplete={walkthrough.markActiveStepComplete}
        onNextStep={walkthrough.selectNextStep}
        onRetry={() => void walkthrough.load(false)}
      />
      {baseMain}
    </>
  )
}
