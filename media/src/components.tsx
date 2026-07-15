import type { CSSProperties, ReactNode } from "react"
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion"

import type { ProductCamera, PromoFormat } from "./campaign"

const colors = {
  background: "#06101c",
  foreground: "#f4f7fb",
  muted: "#94a3b8",
  emerald: "#22c983",
  coral: "#f36d72",
  line: "rgba(148, 163, 184, 0.18)",
} as const

/** Branded navy stage with restrained grid and color bloom. */
export function BrandBackdrop({ children }: { readonly children: ReactNode }) {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: colors.background,
        color: colors.foreground,
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${colors.line} 1px, transparent 1px), linear-gradient(90deg, ${colors.line} 1px, transparent 1px)`,
          backgroundSize: "72px 72px",
          maskImage: "linear-gradient(to bottom, rgba(0,0,0,.45), transparent 72%)",
          opacity: 0.24,
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 760,
          height: 760,
          right: -260,
          top: -320,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(34,201,131,.18), transparent 66%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 620,
          height: 620,
          left: -300,
          bottom: -360,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(243,109,114,.13), transparent 68%)",
        }}
      />
      {children}
    </AbsoluteFill>
  )
}

/** DiffDash campaign wordmark with the release marker. */
export function Wordmark({ compact = false }: { readonly compact?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: compact ? 12 : 18 }}>
      <div
        style={{
          width: compact ? 36 : 52,
          height: compact ? 36 : 52,
          border: `1px solid rgba(34,201,131,.65)`,
          borderRadius: compact ? 11 : 15,
          display: "grid",
          placeItems: "center",
          color: colors.emerald,
          fontSize: compact ? 22 : 30,
          boxShadow: "inset 0 0 24px rgba(34,201,131,.12)",
        }}
      >
        ✦
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: compact ? 10 : 14 }}>
        <strong style={{ fontSize: compact ? 24 : 38, letterSpacing: "-0.04em" }}>DiffDash</strong>
        <span style={{ color: colors.muted, fontSize: compact ? 16 : 20 }}>v0.2.1</span>
      </div>
    </div>
  )
}

/** Animated editorial copy block shared by product scenes. */
export function HeadlineBlock({
  eyebrow,
  headline,
  detail,
  format,
}: {
  readonly eyebrow: string
  readonly headline: string
  readonly detail: string
  readonly format: PromoFormat
}) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const entrance = spring({ frame, fps, config: { damping: 18, stiffness: 110, mass: 0.8 } })
  const style: CSSProperties =
    format === "landscape"
      ? { position: "absolute", left: 86, top: 210, width: 370 }
      : { position: "absolute", left: 72, right: 72, top: 170 }

  return (
    <div
      style={{
        ...style,
        opacity: entrance,
        transform: `translateY(${interpolate(entrance, [0, 1], [34, 0])}px)`,
      }}
    >
      <div
        style={{
          color: colors.emerald,
          textTransform: "uppercase",
          fontSize: format === "landscape" ? 16 : 23,
          letterSpacing: "0.18em",
          fontWeight: 700,
          marginBottom: format === "landscape" ? 20 : 24,
        }}
      >
        {eyebrow}
      </div>
      <div
        style={{
          fontSize: format === "landscape" ? 62 : 82,
          lineHeight: 0.98,
          letterSpacing: "-0.055em",
          fontWeight: 650,
          textWrap: "balance",
        }}
      >
        {headline}
      </div>
      <div
        style={{
          color: colors.muted,
          fontSize: format === "landscape" ? 21 : 29,
          lineHeight: 1.45,
          marginTop: format === "landscape" ? 26 : 30,
          maxWidth: format === "landscape" ? 350 : 850,
        }}
      >
        {detail}
      </div>
    </div>
  )
}

/** Staged product window with deterministic camera framing over a real DiffDash capture. */
export function ProductWindow({
  shot,
  camera,
  format,
}: {
  readonly shot: string
  readonly camera: ProductCamera
  readonly format: PromoFormat
}) {
  const frame = useCurrentFrame()
  const drift = interpolate(frame, [0, 240], [1.015, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  })
  const windowStyle: CSSProperties =
    format === "landscape"
      ? { position: "absolute", left: 500, top: 105, width: 1330, height: 860 }
      : { position: "absolute", left: 70, top: 590, width: 940, height: 1120 }
  const imageBaseWidth = format === "landscape" ? 1330 : 1440

  return (
    <div
      style={{
        ...windowStyle,
        overflow: "hidden",
        border: "1px solid rgba(148,163,184,.28)",
        borderRadius: format === "landscape" ? 24 : 30,
        background: "#111827",
        boxShadow: "0 44px 110px rgba(0,0,0,.48), 0 0 0 1px rgba(255,255,255,.03)",
      }}
    >
      <div
        style={{
          height: format === "landscape" ? 40 : 52,
          borderBottom: "1px solid rgba(148,163,184,.18)",
          display: "flex",
          alignItems: "center",
          padding: "0 18px",
          gap: 8,
          background: "rgba(8,15,27,.96)",
          position: "relative",
          zIndex: 2,
        }}
      >
        {[colors.coral, "#f4be4f", colors.emerald].map((color) => (
          <div
            key={color}
            style={{ width: 11, height: 11, borderRadius: "50%", background: color }}
          />
        ))}
        <span style={{ marginLeft: 12, color: colors.muted, fontSize: 13 }}>DiffDash</span>
      </div>
      <div
        style={{ position: "absolute", inset: format === "landscape" ? "40px 0 0" : "52px 0 0" }}
      >
        <Img
          src={staticFile(shot)}
          style={{
            position: "absolute",
            width: imageBaseWidth,
            height: imageBaseWidth / 1.6,
            maxWidth: "none",
            transformOrigin: "top left",
            transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale * drift})`,
          }}
        />
      </div>
    </div>
  )
}

/** Promotional cursor rendered independently from browser capture timing. */
export function Cursor({
  format,
  from,
  to,
}: {
  readonly format: PromoFormat
  readonly from: readonly [number, number]
  readonly to: readonly [number, number]
}) {
  const frame = useCurrentFrame()
  const progress = interpolate(frame, [18, 85], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  })
  const click = interpolate(frame, [86, 91, 101], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const scale = format === "landscape" ? 1 : 1.35
  return (
    <div
      style={{
        position: "absolute",
        left: interpolate(progress, [0, 1], [from[0], to[0]]),
        top: interpolate(progress, [0, 1], [from[1], to[1]]),
        width: 28 * scale,
        height: 36 * scale,
        filter: "drop-shadow(0 5px 8px rgba(0,0,0,.45))",
      }}
    >
      <div
        style={{
          position: "absolute",
          width: 48 * scale,
          height: 48 * scale,
          left: -16 * scale,
          top: -16 * scale,
          border: `2px solid ${colors.emerald}`,
          borderRadius: "50%",
          opacity: click,
          transform: `scale(${0.65 + click * 0.55})`,
        }}
      />
      <svg viewBox="0 0 28 36" width="100%" height="100%">
        <path
          d="M2 2L24 20L14.5 21.5L19.5 32L14 34L9 23.5L2 30Z"
          fill="#f8fafc"
          stroke="#07111f"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

/** Full-frame campaign hook with a strong editorial type treatment. */
export function HookScene({ format }: { readonly format: PromoFormat }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const reveal = spring({ frame, fps, config: { damping: 20, stiffness: 95 } })
  const fontSize = format === "landscape" ? 118 : 132
  return (
    <BrandBackdrop>
      <div style={{ position: "absolute", left: format === "landscape" ? 92 : 70, top: 64 }}>
        <Wordmark compact />
      </div>
      <div
        style={{
          position: "absolute",
          left: format === "landscape" ? 90 : 68,
          right: format === "landscape" ? 620 : 60,
          top: format === "landscape" ? 300 : 470,
          fontSize,
          lineHeight: 0.91,
          letterSpacing: "-0.065em",
          fontWeight: 680,
          opacity: reveal,
          transform: `translateY(${interpolate(reveal, [0, 1], [54, 0])}px)`,
        }}
      >
        A pull request shouldn’t feel like a{" "}
        <span style={{ color: colors.coral }}>scavenger hunt.</span>
      </div>
      <div
        style={{
          position: "absolute",
          right: format === "landscape" ? 80 : -180,
          bottom: format === "landscape" ? -210 : 60,
          width: format === "landscape" ? 700 : 760,
          height: format === "landscape" ? 700 : 760,
          border: `1px solid rgba(34,201,131,.35)`,
          borderRadius: "50%",
          boxShadow: "inset 0 0 140px rgba(34,201,131,.08)",
        }}
      />
    </BrandBackdrop>
  )
}

/** Closing campaign card with product promise and destination. */
export function EndCard({ format }: { readonly format: PromoFormat }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const reveal = spring({ frame, fps, config: { damping: 18, stiffness: 85 } })
  return (
    <BrandBackdrop>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          textAlign: "center",
          padding: 80,
          opacity: reveal,
          transform: `scale(${interpolate(reveal, [0, 1], [0.94, 1])})`,
        }}
      >
        <Wordmark />
        <div
          style={{
            marginTop: format === "landscape" ? 74 : 120,
            maxWidth: format === "landscape" ? 1180 : 900,
            fontSize: format === "landscape" ? 96 : 120,
            lineHeight: 0.94,
            letterSpacing: "-0.06em",
            fontWeight: 680,
          }}
        >
          Review without losing the <span style={{ color: colors.emerald }}>thread.</span>
        </div>
        <div
          style={{
            marginTop: 58,
            border: `1px solid rgba(34,201,131,.6)`,
            borderRadius: 999,
            padding: format === "landscape" ? "18px 34px" : "24px 42px",
            color: colors.emerald,
            fontSize: format === "landscape" ? 24 : 34,
            letterSpacing: "0.03em",
          }}
        >
          usediffdash.com
        </div>
      </div>
    </BrandBackdrop>
  )
}
