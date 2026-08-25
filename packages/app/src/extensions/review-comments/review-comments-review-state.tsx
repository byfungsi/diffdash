import type { ReviewThreadAnchor, ReviewThreadId } from "@diffdash/domain/review-thread"
import { Option } from "effect"
import {
  createContext,
  type ReactNode,
  type RefObject,
  use,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react"

import type { ReviewThreadSidebarState } from "./review-thread-sidebar"
import type { ReviewThreadScopeIdentity } from "./review-thread-scope"
import type { ReviewThreadsController } from "./review-threads"

interface ReviewCommentsReviewRegistration {
  readonly scopeKey: ReviewThreadScopeIdentity
  readonly version: string
  readonly controller: ReviewThreadsController
  readonly revealLine: (anchor: ReviewThreadAnchor) => void
}

/** Review-scoped list/detail coordination owned by the Review Comments extension. */
export interface ReviewCommentsReviewState {
  readonly registration: ReviewCommentsReviewRegistration | null
  readonly sidebarState: ReviewThreadSidebarState
  readonly buttonRefs: RefObject<Map<ReviewThreadId, HTMLButtonElement>>
  readonly setSidebarState: (state: ReviewThreadSidebarState) => void
  readonly publish: (
    scopeKey: ReviewThreadScopeIdentity,
    version: string,
    controller: ReviewThreadsController,
    revealLine: (anchor: ReviewThreadAnchor) => void,
  ) => void
  readonly clear: (scopeKey: ReviewThreadScopeIdentity) => void
}

const ReviewCommentsReviewStateContext = createContext<ReviewCommentsReviewState | null>(null)

/** Retains Review Comments pane state independently from the Review host. */
export const ReviewCommentsReviewStateProvider = ({
  children,
}: {
  readonly children: ReactNode
}) => {
  const [registration, setRegistration] = useState<Option.Option<ReviewCommentsReviewRegistration>>(
    Option.none,
  )
  const [sidebarState, setSidebarState] = useState<ReviewThreadSidebarState>({ _tag: "collapsed" })
  const buttonRefs = useRef(new Map<ReviewThreadId, HTMLButtonElement>())
  const activeScopeKeyRef = useRef<Option.Option<ReviewThreadScopeIdentity>>(Option.none())
  const publish = useCallback(
    (
      scopeKey: ReviewThreadScopeIdentity,
      version: string,
      controller: ReviewThreadsController,
      revealLine: (anchor: ReviewThreadAnchor) => void,
    ) => {
      if (!Option.contains(activeScopeKeyRef.current, scopeKey)) {
        activeScopeKeyRef.current = Option.some(scopeKey)
        setSidebarState({ _tag: "collapsed" })
      }
      setRegistration((current) =>
        Option.exists(
          current,
          (active) => active.scopeKey === scopeKey && active.version === version,
        )
          ? current
          : Option.some({ scopeKey, version, controller, revealLine }),
      )
    },
    [],
  )
  const clear = useCallback((scopeKey: ReviewThreadScopeIdentity) => {
    if (!Option.contains(activeScopeKeyRef.current, scopeKey)) return
    activeScopeKeyRef.current = Option.none()
    setRegistration(Option.none())
    setSidebarState({ _tag: "collapsed" })
  }, [])
  const value = useMemo<ReviewCommentsReviewState>(
    () => ({
      registration: Option.getOrNull(registration),
      sidebarState,
      buttonRefs,
      setSidebarState,
      publish,
      clear,
    }),
    [clear, publish, registration, sidebarState],
  )
  return (
    <ReviewCommentsReviewStateContext value={value}>{children}</ReviewCommentsReviewStateContext>
  )
}

/** Returns Review Comments state shared by its diff behavior and activity panes. */
export const useReviewCommentsReviewState = (): ReviewCommentsReviewState => {
  const state = use(ReviewCommentsReviewStateContext)
  if (state === null) throw new Error("ReviewCommentsReviewStateProvider is unavailable")
  return state
}
