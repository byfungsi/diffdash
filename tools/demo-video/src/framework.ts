import type { Page } from "playwright"

/** Copy rendered on a release or chapter cover. */
export interface CardCopy {
  readonly step: string
  readonly eyebrow: string
  readonly title: string
  readonly caption: string
}

/** Human-readable locator resolved through Playwright's accessible selectors. */
export type Target =
  | string
  | { readonly button: string | RegExp; readonly exact?: boolean }
  | { readonly textbox: string | RegExp; readonly exact?: boolean }
  | { readonly placeholder: string; readonly exact?: boolean }
  | { readonly text: string | RegExp; readonly exact?: boolean }
  | { readonly role: string; readonly name?: string | RegExp; readonly exact?: boolean }
  | { readonly testId: string }
  | { readonly css: string }

/** Execution context available to custom clip operations. */
export interface RunContext {
  readonly page: Page
}

/** One direct Playwright operation in a recorded clip. */
export type Step =
  | { readonly kind: "click"; readonly target: Target }
  | { readonly kind: "type"; readonly target: Target; readonly text: string }
  | { readonly kind: "press"; readonly target: Target; readonly key: string }
  | {
      readonly kind: "annotate"
      readonly target: Target
      readonly body: string
      readonly title?: string
      readonly placement?: "top" | "bottom" | "left" | "right"
      readonly hold?: number
    }
  | { readonly kind: "pause"; readonly ms?: number }
  | { readonly kind: "wait"; readonly target: Target; readonly timeout?: number }
  | { readonly kind: "release"; readonly checkpoint: string }
  | {
      readonly kind: "raw"
      readonly label: string
      readonly run: (context: RunContext) => Promise<void>
    }

/** Independently recorded Playwright take and its preceding chapter cover. */
export interface DemoClip {
  readonly name: string
  readonly card: CardCopy
  readonly steps: readonly Step[]
}

/** Ordered source of truth for one stitched demo release. */
export interface DemoStory {
  readonly id: string
  readonly title: string
  readonly intro: CardCopy
  readonly outro: CardCopy
  readonly clips: readonly DemoClip[]
}

/** Serializable recording manifest consumed by the FFmpeg combiner. */
export interface DemoManifest {
  readonly schemaVersion: 1
  readonly story: string
  readonly title: string
  readonly viewport: { readonly width: number; readonly height: number }
  readonly intro: CardCopy
  readonly outro: CardCopy
  readonly clips: readonly {
    readonly name: string
    readonly file: string
    readonly trimStartSeconds: number
    readonly card: CardCopy
  }[]
}
