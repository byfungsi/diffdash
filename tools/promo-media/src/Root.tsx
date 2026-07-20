import { Composition } from "remotion"

import { PROMO_DURATION_IN_FRAMES, PROMO_FPS } from "./campaign"
import { Promo } from "./Promo"
import "./load-font"
import "./styles.css"

/** Registers all v0.2.1 campaign delivery compositions. */
export function RemotionRoot() {
  return (
    <>
      <Composition
        id="PromoLandscape"
        component={Promo}
        defaultProps={{ format: "landscape" as const }}
        durationInFrames={PROMO_DURATION_IN_FRAMES}
        fps={PROMO_FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="PromoVertical"
        component={Promo}
        defaultProps={{ format: "vertical" as const }}
        durationInFrames={PROMO_DURATION_IN_FRAMES}
        fps={PROMO_FPS}
        width={1080}
        height={1920}
      />
    </>
  )
}
