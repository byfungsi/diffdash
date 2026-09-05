import type { ParsedDiffFile } from "@diffdash/domain/diff"
import { isVeryLargeDiffFile } from "@diffdash/domain/large-diff-policy"
import { Effect, Option } from "effect"
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"
import { ContextMenu } from "radix-ui"
import { isHTMLElement } from "@/shared/dom"
import type { ReviewKey } from "@diffdash/domain/review-identity"
import { DiffCardHeader, OpenDiffCard, diffLineNumberFromEventPath } from "./diff-card"
import {
  CodeView,
  getSingularPatch,
  useStableCallback,
  type CodeViewDiffItem,
  type CodeViewHandle,
  type CodeViewReactOptions,
  type FileDiffMetadata,
} from "./pierre"
import type { ReviewDiffAnnotationMetadata } from "./review-diff-annotation"
import { diffCardDomId } from "./viewed-file-viewport"

type CardProps = Parameters<typeof OpenDiffCard>[0]

/** Whole-review virtualization: only viewport files own DOM, headers and annotations. */
export function ReviewCodeView({
  viewport,
  ...props
}: Parameters<typeof VirtualReviewCodeView>[0] & {
  readonly viewport: "cards" | "code-view"
}) {
  return viewport === "code-view" ? (
    <VirtualReviewCodeView {...props} />
  ) : (
    props.files.map((file) => <OpenDiffCard key={file.reviewKey} {...props.getCardProps(file)} />)
  )
}

function VirtualReviewCodeView({
  files,
  getCardProps,
  containerRef,
  ref,
  target,
}: {
  readonly files: readonly ParsedDiffFile[]
  readonly getCardProps: (file: ParsedDiffFile) => CardProps
  readonly containerRef: (element: HTMLDivElement | null) => void
  readonly ref: RefObject<CodeViewHandle<ReviewDiffAnnotationMetadata> | null>
  readonly target: { readonly reviewKey: ReviewKey } | null
}) {
  const cache = useRef(new WeakMap<ParsedDiffFile, FileDiffMetadata>())
  const itemCache = useRef(
    new WeakMap<
      ParsedDiffFile,
      {
        readonly item: CodeViewDiffItem<ReviewDiffAnnotationMetadata>
        readonly provider: CardProps["annotationProvider"]
        readonly anchor: CardProps["navigationAnchor"]
      }
    >(),
  )
  const cards = new Map<string, CardProps>(
    files.map((file) => [file.reviewKey, getCardProps(file)]),
  )
  const cardsRef = useRef(cards)
  cardsRef.current = cards
  const anchors = useRef(
    new Map<HTMLElement, { readonly card: CardProps; readonly release: () => void }>(),
  )
  const appliedTarget = useRef<typeof target>(null)
  const [menu, setMenu] = useState<{
    readonly file: ParsedDiffFile
    readonly line: number
    readonly status: "idle" | "copying" | "failed"
  } | null>(null)
  const copyGeneration = useRef(0)
  const items: CodeViewDiffItem<ReviewDiffAnnotationMetadata>[] = files.map((file) => {
    let fileDiff = cache.current.get(file)
    if (fileDiff === undefined) {
      fileDiff = { ...getSingularPatch(file.patch), cacheKey: `${file.fileId}:${file.patchHash}` }
      if (isVeryLargeDiffFile(file)) fileDiff.lang = "text"
      cache.current.set(file, fileDiff)
    }
    const card = cards.get(file.reviewKey)
    const collapsed = card === undefined || !(card.forceExpanded || (card.expanded && !card.viewed))
    const previous = itemCache.current.get(file)
    if (
      previous !== undefined &&
      previous.provider === card?.annotationProvider &&
      previous.anchor === card.navigationAnchor &&
      previous.item.collapsed === collapsed
    )
      return previous.item
    const item: CodeViewDiffItem<ReviewDiffAnnotationMetadata> = {
      type: "diff",
      id: file.reviewKey,
      version: (previous?.item.version ?? 0) + 1,
      fileDiff,
      collapsed,
      annotations:
        card
          ?.annotationProvider(file, card.navigationAnchor)
          .map(({ lineNumber, side, render }) => ({ lineNumber, side, metadata: { render } })) ??
        [],
    }
    if (card !== undefined)
      itemCache.current.set(file, {
        item,
        provider: card.annotationProvider,
        anchor: card.navigationAnchor,
      })
    return item
  })
  const shared = cards.values().next().value?.diffOptions
  const targetAvailable = target !== null && cards.has(target.reviewKey)
  useLayoutEffect(() => {
    if (target === null || target === appliedTarget.current || !targetAvailable) return
    ref.current?.scrollTo({
      type: "item",
      id: target.reviewKey,
      align: "start",
      behavior: "instant",
    })
    appliedTarget.current = target
  }, [target, targetAvailable, ref])
  const sharedRef = useRef(shared)
  sharedRef.current = shared
  const tokenClick = useStableCallback<
    NonNullable<CodeViewReactOptions<ReviewDiffAnnotationMetadata>["onTokenClick"]>
  >((token, event, context) => {
    if (context.type === "diff" && "side" in token) sharedRef.current?.onTokenClick?.(token, event)
  })
  const tokenEnter = useStableCallback<
    NonNullable<CodeViewReactOptions<ReviewDiffAnnotationMetadata>["onTokenEnter"]>
  >((token, event, context) => {
    if (context.type === "diff" && "side" in token) sharedRef.current?.onTokenEnter?.(token, event)
  })
  const tokenLeave = useStableCallback<
    NonNullable<CodeViewReactOptions<ReviewDiffAnnotationMetadata>["onTokenLeave"]>
  >((token, event, context) => {
    if (context.type === "diff" && "side" in token) sharedRef.current?.onTokenLeave?.(token, event)
  })
  const loadDiffFiles = useStableCallback<
    NonNullable<CodeViewReactOptions<ReviewDiffAnnotationMetadata>["loadDiffFiles"]>
  >(async (metadata) => {
    for (const card of cardsRef.current.values()) {
      if (cache.current.get(card.file)?.cacheKey === metadata.cacheKey)
        return card.onLoadDiffFiles()
    }
    throw new Error("The diff file is no longer mounted in this review.")
  })
  const postRender = useStableCallback<
    NonNullable<CodeViewReactOptions<ReviewDiffAnnotationMetadata>["onPostRender"]>
  >((host, _instance, phase, context) => {
    if (context.type !== "diff") return
    const previous = anchors.current.get(host)
    const card = cardsRef.current.get(context.item.id) ?? previous?.card
    if (card === undefined) return
    host.id = diffCardDomId(card.file.reviewKey)
    host.dataset.diffCardPath = card.file.path
    host.dataset.diffCardReviewKey = card.file.reviewKey
    host.dataset.reviewFileId = card.file.fileId
    host.dataset.diffFileStatus = card.file.status
    host.dataset.diffRenderMode = isVeryLargeDiffFile(card.file) ? "plain" : "highlighted"
    host.classList.add("bg-card", "border-b", "md:rounded-2xl", "md:border", "overflow-clip")
    host.tabIndex = -1
    if (phase === "unmount") {
      previous?.release()
      anchors.current.delete(host)
    } else if (previous?.card.file !== card.file) {
      previous?.release()
      anchors.current.set(host, { card, release: card.onFileAnchorChange(host, host) })
    }
    Effect.runSync(
      card.surfaceRuntime.publishRender(card.file.reviewKey, host, context.instance, phase),
    )
    if (phase !== "unmount" && (context.item.annotations?.length ?? 0) > 0) {
      requestAnimationFrame(() => {
        if (host.isConnected) card.onAnnotationsRendered(host)
      })
    }
  })
  const lineNumberClick = useStableCallback<
    NonNullable<CodeViewReactOptions<ReviewDiffAnnotationMetadata>["onLineNumberClick"]>
  >((line, context) => {
    if (context.type !== "diff" || !("annotationSide" in line)) return
    cardsRef.current.get(context.item.id)?.onActivateLine(line.annotationSide, line.lineNumber)
  })
  const gutterClick = useStableCallback<
    NonNullable<CodeViewReactOptions<ReviewDiffAnnotationMetadata>["onGutterUtilityClick"]>
  >((line, context) => {
    if (context.type !== "diff" || line.side === undefined) return
    cardsRef.current.get(context.item.id)?.onActivateLine(line.side, line.start)
  })
  const options = useMemo<CodeViewReactOptions<ReviewDiffAnnotationMetadata>>(
    () => ({
      theme: shared?.theme ?? "pierre-light",
      themeType: shared?.themeType ?? "light",
      diffStyle: shared?.diffStyle ?? "unified",
      overflow: shared?.overflow ?? "wrap",
      unsafeCSS: shared?.unsafeCSS ?? "",
      disableFileHeader: false,
      enableGutterUtility: shared?.enableGutterUtility ?? false,
      lineDiffType: shared?.lineDiffType ?? "none",
      onPostRender: postRender,
      onLineNumberClick: lineNumberClick,
      onGutterUtilityClick: gutterClick,
      onTokenClick: tokenClick,
      onTokenEnter: tokenEnter,
      onTokenLeave: tokenLeave,
      loadDiffFiles,
      itemMetrics: { lineHeight: 20, diffHeaderHeight: 40, hunkLineCount: 50 },
      layout:
        shared?.overflow === "scroll"
          ? { paddingTop: 0, paddingBottom: 0, gap: 0 }
          : { paddingTop: 16, paddingBottom: 16, gap: 16 },
    }),
    [
      shared,
      postRender,
      lineNumberClick,
      gutterClick,
      tokenClick,
      tokenEnter,
      tokenLeave,
      loadDiffFiles,
    ],
  )
  return (
    <ContextMenu.Root
      open={menu !== null}
      onOpenChange={(open) => {
        if (!open) {
          copyGeneration.current += 1
          setMenu(null)
        }
      }}
    >
      <ContextMenu.Trigger asChild>
        <div
          className="min-h-0 flex-1"
          onContextMenu={(event) => {
            const path = event.nativeEvent.composedPath()
            const host = path.find(
              (candidate) =>
                isHTMLElement(candidate) && candidate.dataset.diffCardReviewKey !== undefined,
            )
            const card = isHTMLElement(host)
              ? cardsRef.current.get(host.dataset.diffCardReviewKey ?? "")
              : undefined
            const line = diffLineNumberFromEventPath(path)
            if (card === undefined || Option.isNone(line)) {
              event.preventDefault()
              return
            }
            copyGeneration.current += 1
            setMenu({ file: card.file, line: line.value, status: "idle" })
          }}
        >
          <CodeView
            ref={ref}
            containerRef={containerRef}
            className="h-full min-h-0 overflow-auto text-xs md:px-5"
            items={items}
            options={options}
            renderAnnotation={(annotation) => annotation.metadata.render()}
            renderCustomHeader={(item) => {
              const card = cards.get(item.id)
              return card === undefined ? null : <CodeViewHeader card={card} />
            }}
          />
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          aria-label="Diff line actions"
          className="bg-popover text-popover-foreground z-50 min-w-44 rounded-xl border p-1 shadow-lg"
        >
          <ContextMenu.Item
            className="data-[highlighted]:bg-accent rounded-lg px-2.5 py-2 text-xs outline-none"
            disabled={menu?.status === "copying"}
            onSelect={(event) => {
              event.preventDefault()
              if (menu === null) return
              const generation = ++copyGeneration.current
              setMenu({ ...menu, status: "copying" })
              void navigator.clipboard.writeText(`@${menu.file.path}:${menu.line}`).then(
                () => {
                  if (copyGeneration.current === generation) setMenu(null)
                  return undefined
                },
                () => {
                  if (copyGeneration.current === generation) setMenu({ ...menu, status: "failed" })
                },
              )
            }}
          >
            {menu?.status === "copying"
              ? "Copying path..."
              : menu?.status === "failed"
                ? "Copy failed, retry"
                : "Copy path"}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

function CodeViewHeader({ card }: { readonly card: CardProps }) {
  const focusRef = useRef<HTMLButtonElement>(null)
  return (
    <DiffCardHeader
      file={card.file}
      expanded={card.forceExpanded || (card.expanded && !card.viewed)}
      viewed={card.viewed}
      focusRef={focusRef}
      onOpenFile={card.onOpenFile}
      onSelect={card.onSelect}
      onSetViewed={card.onSetViewed}
      onToggleExpanded={card.onToggleExpanded}
    />
  )
}
