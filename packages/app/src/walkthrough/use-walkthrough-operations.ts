import { ReviewThreadTarget } from "@diffdash/domain/review-thread"
import { Schema } from "effect"
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react"

import { useWalkthroughOperationsFactory } from "@/platform/renderer-runtime"
import type {
  WalkthroughOperationSession,
  WalkthroughOperationState,
} from "@/platform/walkthrough-operations"

/** Target-scoped walkthrough operation API with authoritative reactive state. */
export interface WalkthroughOperationController {
  readonly state: WalkthroughOperationState
  readonly getStored: WalkthroughOperationSession["getStored"]
  readonly start: WalkthroughOperationSession["start"]
  readonly cancel: WalkthroughOperationSession["cancel"]
}

/** Opens one durable walkthrough operation session for the mounted review target. */
export const useWalkthroughOperations = (
  target: ReviewThreadTarget,
): WalkthroughOperationController => {
  const operations = useWalkthroughOperationsFactory()
  const targetIdentity = JSON.stringify(Schema.encodeSync(ReviewThreadTarget)(target))
  const stableTargetRef = useRef({ identity: targetIdentity, target })
  if (stableTargetRef.current.identity !== targetIdentity) {
    stableTargetRef.current = { identity: targetIdentity, target }
  }
  const stableTarget = stableTargetRef.current.target
  const session = useMemo(() => operations.open(stableTarget), [operations, stableTarget])
  useEffect(() => () => session.dispose(), [session])
  const state = useSyncExternalStore(session.subscribe, session.state, session.state)

  return {
    state,
    getStored: session.getStored,
    start: session.start,
    cancel: session.cancel,
  }
}
