import { useSyncExternalStore } from "react"

// Matches the Tailwind md breakpoint used by the compact review chrome.
const mobileDiffQuery = "(width < 48rem)"

const subscribeMobileDiffViewport = (listener: () => void) => {
  const media = window.matchMedia(mobileDiffQuery)
  media.addEventListener("change", listener)
  return () => media.removeEventListener("change", listener)
}

const mobileDiffViewportSnapshot = () => window.matchMedia(mobileDiffQuery).matches
const serverDiffViewportSnapshot = () => false

/** Keeps mobile code lines unwrapped using Pierre's native horizontal scrolling mode. */
export const useMobileDiffOverflow = (): "scroll" | "wrap" =>
  useSyncExternalStore(
    subscribeMobileDiffViewport,
    mobileDiffViewportSnapshot,
    serverDiffViewportSnapshot,
  )
    ? "scroll"
    : "wrap"
