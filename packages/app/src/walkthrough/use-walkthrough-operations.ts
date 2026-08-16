import type { ReviewThreadTarget } from "@diffdash/domain/review-thread"
import { useEffect, useMemo, useSyncExternalStore } from "react"

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
  const session = useMemo(() => operations.open(target), [operations, target])
  useEffect(() => () => session.dispose(), [session])
  const state = useSyncExternalStore(session.subscribe, session.state, session.state)

  return {
    state,
    getStored: session.getStored,
    start: session.start,
    cancel: session.cancel,
  }
}
