import { afterEach, assert, describe, expect, it, vi } from "vitest"
import { Effect, Option, Schema } from "effect"

import {
  SourceSurfaceCapabilityError,
  SourceSurfaceContributionId,
  SourceSurfaceRuntime,
  type SourceSurfaceInteractionRoute,
  type SourceSurfaceTokenTarget,
} from "./source-surface-runtime"

const observerId = (suffix: string) => SourceSurfaceContributionId.make(`diffdash.test.${suffix}`)

afterEach(() => {
  document.body.replaceChildren()
})

describe("SourceSurfaceRuntime", () => {
  it("validates contribution IDs and reports duplicate registration as a typed failure", () => {
    expect(() => SourceSurfaceContributionId.make("Invalid contribution")).toThrow(
      /Schema validation failed/u,
    )
    const runtime = new SourceSurfaceRuntime<object>()
    const id = observerId("duplicate")
    Effect.runSync(runtime.registerInteractionRoute({ id, phase: "fallback", handle: () => false }))

    const duplicate = Effect.runSync(
      Effect.flip(runtime.registerInteractionRoute({ id, phase: "fallback", handle: () => false })),
    )
    expect(Schema.is(SourceSurfaceCapabilityError)(duplicate)).toBe(true)
  })

  it("ignores a delayed unmount for an instance that no longer owns the host", () => {
    const runtime = new SourceSurfaceRuntime<object>()
    const host = document.createElement("div")
    const first = {}
    const second = {}
    const observed: Array<{ readonly instance: object; readonly phase: string }> = []
    Effect.runSync(
      runtime.registerRenderObserver(observerId("stale-unmount"), ({ instance, phase }) => {
        observed.push({ instance, phase })
      }),
    )

    Effect.runSync(runtime.publishRender("first.ts", host, first, "mount"))
    Effect.runSync(runtime.publishRender("second.ts", host, second, "mount"))
    Effect.runSync(runtime.publishRender("first.ts", host, first, "unmount"))

    const replayed: object[] = []
    Effect.runSync(
      runtime.registerRenderObserver(observerId("stale-unmount-replay"), ({ instance }) => {
        replayed.push(instance)
      }),
    )
    expect(observed).toEqual([
      { instance: first, phase: "mount" },
      { instance: first, phase: "unmount" },
      { instance: second, phase: "mount" },
    ])
    expect(replayed).toEqual([second])
  })

  it("keeps a durable token anchor scoped to its semantic surface", () => {
    const runtime = new SourceSurfaceRuntime<object>()
    const first = sourceHost("same", new DOMRect(10, 10, 20, 10), 41, "3,2")
    const second = sourceHost("same", new DOMRect(200, 200, 20, 10), 41, "3,2")
    Effect.runSync(runtime.publishRender("first.ts", first.host, {}, "mount"))
    Effect.runSync(runtime.publishRender("second.ts", second.host, {}, "mount"))
    const target: SourceSurfaceTokenTarget = {
      surfaceId: "first.ts",
      lineNumber: 41,
      lineCharStart: 0,
      lineCharEnd: 4,
      tokenText: "same",
      tokenElement: first.token,
      side: Option.none(),
    }
    const anchor = runtime.createTokenAnchor(target)
    first.line.remove()
    const replacement = appendToken(first.host, "same", new DOMRect(30, 40, 20, 10), 41, "3,2")

    expect(anchor.getBoundingClientRect()).toEqual(replacement.getBoundingClientRect())
    replacement.remove()
    expect(anchor.getBoundingClientRect().x).toBe(30)
  })

  it("replays mounted surfaces after a consumer resets passive registration state", () => {
    const runtime = new SourceSurfaceRuntime<object>()
    const host = document.createElement("div")
    const instance = {}
    Effect.runSync(runtime.publishRender("review-file", host, instance, "mount"))
    const registrations: object[] = [{}]

    // Review identity reset must happen before observer registration replays mounted diffs.
    registrations.length = 0
    Effect.runSync(
      runtime.registerRenderObserver(observerId("reset-replay"), ({ instance: rendered }) => {
        registrations.push(rendered)
      }),
    )

    expect(registrations).toEqual([instance])
  })

  it("rolls back replay failures and isolates publication failures", () => {
    const runtime = new SourceSurfaceRuntime<object>()
    const host = document.createElement("div")
    Effect.runSync(runtime.publishRender("source.ts", host, {}, "mount"))
    const replayId = observerId("replay-failure")

    const replayFailure = Effect.runSync(
      Effect.flip(
        runtime.registerRenderObserver(replayId, () => {
          Effect.runSync(Effect.die(new Error("replay failed")))
        }),
      ),
    )
    expect(Schema.is(SourceSurfaceCapabilityError)(replayFailure)).toBe(true)
    Effect.runSync(runtime.registerRenderObserver(replayId, () => undefined))

    const failingId = observerId("publication-failure")
    const laterObserver = vi.fn<() => void>()
    const instance = {}
    Effect.runSync(runtime.publishRender("source.ts", host, instance, "update"))
    Effect.runSync(
      runtime.registerRenderObserver(failingId, ({ phase }) => {
        if (phase === "unmount") Effect.runSync(Effect.die(new Error("unmount failed")))
      }),
    )
    Effect.runSync(runtime.registerRenderObserver(observerId("later-observer"), laterObserver))
    const publicationFailure = Effect.runSync(
      Effect.flip(runtime.publishRender("source.ts", host, instance, "unmount")),
    )
    expect(Schema.is(SourceSurfaceCapabilityError)(publicationFailure)).toBe(true)
    expect(laterObserver).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "unmount" }))

    const replayed = vi.fn<() => void>()
    Effect.runSync(runtime.registerRenderObserver(observerId("after-unmount"), replayed))
    expect(replayed).not.toHaveBeenCalled()
  })

  it("registers a replacement host owner even when displaced unmount notification fails", () => {
    const runtime = new SourceSurfaceRuntime<object>()
    const host = document.createElement("div")
    const first = {}
    const replacement = {}
    Effect.runSync(
      runtime.registerRenderObserver(observerId("displaced-failure"), ({ instance, phase }) => {
        if (instance === first && phase === "unmount") {
          Effect.runSync(Effect.die(new Error("unmount failed")))
        }
      }),
    )
    Effect.runSync(runtime.publishRender("first.ts", host, first, "mount"))

    const failure = Effect.runSync(
      Effect.flip(runtime.publishRender("replacement.ts", host, replacement, "mount")),
    )
    expect(Schema.is(SourceSurfaceCapabilityError)(failure)).toBe(true)

    const replayed = vi.fn<() => void>()
    Effect.runSync(
      runtime.registerRenderObserver(observerId("replacement-replay"), ({ instance, phase }) => {
        if (instance === replacement && phase === "mount") replayed()
      }),
    )
    expect(replayed).toHaveBeenCalledOnce()
  })

  it("uses Pierre source lines instead of rendered row indexes for interaction dispatch", () => {
    const runtime = new SourceSurfaceRuntime<object>()
    const { host, line, token } = sourceHost("token", new DOMRect())
    Effect.runSync(runtime.publishRender("source.ts", host, {}, "mount"))
    host.addEventListener("click", runtime.handleClick)
    const handle = vi.fn<SourceSurfaceInteractionRoute["handle"]>(() => true)
    Effect.runSync(
      runtime.registerInteractionRoute({
        id: observerId("coordinate-route"),
        phase: "lineAction",
        handle,
      }),
    )

    for (const value of ["", "-1", "1.5", String(Number.MAX_SAFE_INTEGER + 1)]) {
      line.dataset.line = value
      token.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, button: 0 }))
    }
    expect(handle).not.toHaveBeenCalled()

    line.dataset.line = "41"
    line.dataset.lineIndex = "3,2"
    token.dataset.char = "0"
    token.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, button: 0 }))
    const interaction = handle.mock.calls[0]?.[0]
    assert(interaction !== undefined, "Expected a valid source-surface interaction")
    expect(interaction.lineNumber).toBe(41)
    expect(Option.map(interaction.token, ({ surfaceId }) => surfaceId)).toEqual(
      Option.some("source.ts"),
    )
  })
})

const sourceHost = (text: string, rect: DOMRect, lineNumber = 1, renderLineIndex = "0") => {
  const host = document.createElement("div")
  host.attachShadow({ mode: "open" })
  document.body.append(host)
  const token = appendToken(host, text, rect, lineNumber, renderLineIndex)
  const line = token.parentElement
  assert(line !== null, "Source test line was not created")
  return { host, line, token }
}

const appendToken = (
  host: HTMLElement,
  text: string,
  rect: DOMRect,
  lineNumber: number,
  renderLineIndex: string,
) => {
  const line = document.createElement("div")
  line.dataset.line = String(lineNumber)
  line.dataset.lineIndex = renderLineIndex
  const token = document.createElement("span")
  token.dataset.char = "0"
  token.textContent = text
  token.getBoundingClientRect = () => rect
  line.append(token)
  host.shadowRoot?.append(line)
  return token
}
