import { useEffect, useState } from "react"
import { spinners as unicodeAnimations } from "unicode-animations"

import { cn } from "@/lib/utils"

const BRAILLE_SPINNER = unicodeAnimations.braille

/** Accessible Unicode activity indicator that respects reduced-motion preferences. */
export const UnicodeLoadingText = ({
  className,
  text,
}: {
  readonly className?: string
  readonly text: string
}) => {
  const [frameIndex, setFrameIndex] = useState(0)
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setReducedMotion(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  useEffect(() => {
    if (reducedMotion) return undefined
    const timer = window.setInterval(
      () => setFrameIndex((index) => (index + 1) % BRAILLE_SPINNER.frames.length),
      BRAILLE_SPINNER.interval,
    )
    return () => window.clearInterval(timer)
  }, [reducedMotion])

  return (
    <output aria-live="polite" className={cn("inline-flex items-center gap-1.5", className)}>
      <span aria-hidden="true" className="font-mono text-sm leading-none">
        {BRAILLE_SPINNER.frames[reducedMotion ? 0 : frameIndex] ?? ""}
      </span>
      <span>{text}</span>
    </output>
  )
}
