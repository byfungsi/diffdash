import { Audio, Sequence, staticFile, useCurrentFrame } from "remotion"

import { PRODUCT_CAMERAS, PRODUCT_SHOTS, PROMO_FPS, type PromoFormat } from "./campaign"
import {
  BrandBackdrop,
  Cursor,
  EndCard,
  HeadlineBlock,
  HookScene,
  ProductWindow,
  Wordmark,
} from "./components"

const seconds = (value: number) => value * PROMO_FPS

/** Complete 42-second DiffDash v0.2.1 promotional campaign. */
export function Promo({ format }: { readonly format: PromoFormat }) {
  return (
    <>
      <Audio src={staticFile("audio/promo-song.mp3")} />
      <Sequence durationInFrames={seconds(4)}>
        <HookScene format={format} />
      </Sequence>
      <Sequence from={seconds(4)} durationInFrames={seconds(7)}>
        <ProductScene
          format={format}
          eyebrow="Review requests"
          headline="Know where to review first."
          detail="Open the work that needs you, without rebuilding the context from scratch."
          shot={PRODUCT_SHOTS.home}
          camera={PRODUCT_CAMERAS[format].home}
          cursorFrom={format === "landscape" ? [1330, 780] : [780, 1280]}
          cursorTo={format === "landscape" ? [1450, 720] : [640, 1180]}
        />
      </Sequence>
      <Sequence from={seconds(11)} durationInFrames={seconds(8)}>
        <ProductScene
          format={format}
          eyebrow="AI walkthrough"
          headline="Follow the change, not the file list."
          detail="DiffDash turns a large PR into a reviewer-first path through the risky decisions."
          shot={PRODUCT_SHOTS.walkthrough}
          camera={PRODUCT_CAMERAS[format].walkthrough}
          cursorFrom={format === "landscape" ? [760, 760] : [760, 1450]}
          cursorTo={format === "landscape" ? [690, 480] : [380, 1080]}
        />
      </Sequence>
      <Sequence from={seconds(19)} durationInFrames={seconds(10)}>
        <ThreadScene format={format} />
      </Sequence>
      <Sequence from={seconds(29)} durationInFrames={seconds(6)}>
        <SafeReviewScene format={format} />
      </Sequence>
      <Sequence from={seconds(35)} durationInFrames={seconds(7)}>
        <EndCard format={format} />
      </Sequence>
    </>
  )
}

function ProductScene({
  format,
  eyebrow,
  headline,
  detail,
  shot,
  camera,
  cursorFrom,
  cursorTo,
}: {
  readonly format: PromoFormat
  readonly eyebrow: string
  readonly headline: string
  readonly detail: string
  readonly shot: string
  readonly camera: (typeof PRODUCT_CAMERAS)[PromoFormat][keyof typeof PRODUCT_SHOTS]
  readonly cursorFrom: readonly [number, number]
  readonly cursorTo: readonly [number, number]
}) {
  return (
    <BrandBackdrop>
      <div style={{ position: "absolute", left: format === "landscape" ? 86 : 70, top: 58 }}>
        <Wordmark compact />
      </div>
      <HeadlineBlock eyebrow={eyebrow} headline={headline} detail={detail} format={format} />
      <ProductWindow shot={shot} camera={camera} format={format} />
      <Cursor format={format} from={cursorFrom} to={cursorTo} />
    </BrandBackdrop>
  )
}

function ThreadScene({ format }: { readonly format: PromoFormat }) {
  const frame = useCurrentFrame()
  const completed = frame >= seconds(4.6)
  return (
    <ProductScene
      format={format}
      eyebrow="Inline AI threads"
      headline="Ask questions without losing context."
      detail="Keep every answer attached to the exact line and carry the conversation across revisions."
      shot={completed ? PRODUCT_SHOTS.threadComplete : PRODUCT_SHOTS.threadPending}
      camera={
        completed ? PRODUCT_CAMERAS[format].threadComplete : PRODUCT_CAMERAS[format].threadPending
      }
      cursorFrom={format === "landscape" ? [1560, 800] : [820, 1510]}
      cursorTo={format === "landscape" ? [1220, 690] : [570, 1310]}
    />
  )
}

function SafeReviewScene({ format }: { readonly format: PromoFormat }) {
  const frame = useCurrentFrame()
  const approved = frame >= seconds(3.2)
  return (
    <ProductScene
      format={format}
      eyebrow="Isolated review"
      headline="Your checkout stays untouched."
      detail="Review the exact PR revision, keep local work safe, and approve when the thread is resolved."
      shot={approved ? PRODUCT_SHOTS.approved : PRODUCT_SHOTS.revisionUpdated}
      camera={approved ? PRODUCT_CAMERAS[format].approved : PRODUCT_CAMERAS[format].revisionUpdated}
      cursorFrom={format === "landscape" ? [1580, 180] : [790, 850]}
      cursorTo={format === "landscape" ? [1760, 120] : [800, 720]}
    />
  )
}
