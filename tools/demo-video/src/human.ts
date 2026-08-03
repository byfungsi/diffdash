/* eslint-disable no-await-in-loop, no-shadow -- Cursor and fade frames must be drawn serially; evaluated browser bindings intentionally mirror payload names. */
import type { Locator, Page } from "playwright"

let cursorX = 1180
let cursorY = 760
let randomState = 1

/** Seed human timing so repeated recordings remain visually reproducible. */
export const setHumanSeed = (seed: number) => {
  randomState = seed || 1
  cursorX = 1180
  cursorY = 760
}

const random = () => {
  randomState = (randomState * 1_664_525 + 1_013_904_223) >>> 0
  return randomState / 0x1_0000_0000
}

const rand = (min: number, max: number) => min + Math.floor(random() * (max - min + 1))

const drawCursor = async (page: Page, x: number, y: number, down = false) => {
  cursorX = x
  cursorY = y
  await page.evaluate(
    ({ x, y, down }) => {
      const id = "__diffdash_demo_cursor"
      let cursor = document.getElementById(id)
      if (cursor === null) {
        cursor = document.createElement("div")
        cursor.id = id
        cursor.style.cssText =
          "position:fixed;top:0;left:0;border-radius:50%;background:rgba(37,99,235,.45);" +
          "border:3px solid #1d4ed8;box-shadow:0 0 0 3px rgba(255,255,255,.9),0 2px 8px rgba(0,0,0,.45);" +
          "z-index:2147483647;pointer-events:none;margin-left:-14px;margin-top:-14px;"
        document.documentElement.append(cursor)
      }
      const size = down ? "18px" : "28px"
      cursor.style.width = size
      cursor.style.height = size
      cursor.style.transform = `translate(${x}px, ${y}px)`
    },
    { x, y, down },
  )
}

/** Install the visible recording cursor. */
export const ensureCursor = async (page: Page) => {
  await page.addStyleTag({ content: "* { cursor: none !important; }" })
  await drawCursor(page, cursorX, cursorY)
}

/** Pause for a natural reading beat. */
export const pause = async (page: Page, min = 500, max = 1_100) => {
  await page.waitForTimeout(rand(min, max))
}

const moveTo = async (page: Page, locator: Locator) => {
  await locator.scrollIntoViewIfNeeded().catch(() => undefined)
  const box = await locator.boundingBox()
  if (box === null) throw new Error("Demo target has no visible bounds")
  const targetX = box.x + box.width / 2
  const targetY = box.y + box.height / 2 + rand(-4, 4)
  const steps = rand(16, 26)
  const startX = cursorX
  const startY = cursorY
  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps
    const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2
    const x = startX + (targetX - startX) * eased
    const y = startY + (targetY - startY) * eased
    await page.mouse.move(x, y)
    await drawCursor(page, x, y)
    await page.waitForTimeout(rand(8, 18))
  }
}

/** Move, hover, and click like a person. */
export const click = async (page: Page, locator: Locator) => {
  await moveTo(page, locator)
  await page.waitForTimeout(rand(140, 320))
  await drawCursor(page, cursorX, cursorY, true)
  await locator.click({ timeout: 15_000 })
  await drawCursor(page, cursorX, cursorY)
  await page.waitForTimeout(rand(250, 550))
}

/** Focus and type visible text at a human pace. */
export const type = async (page: Page, locator: Locator, text: string) => {
  await moveTo(page, locator)
  await page.waitForTimeout(rand(120, 280))
  await drawCursor(page, cursorX, cursorY, true)
  await locator.click()
  await drawCursor(page, cursorX, cursorY)
  await page.waitForTimeout(rand(150, 300))
  await locator.fill("")
  await locator.pressSequentially(text, { delay: rand(70, 130) })
  await page.waitForTimeout(rand(250, 500))
}

const annotationId = "__diffdash_demo_annotation"

const setAnnotationOpacity = async (page: Page, opacity: number) => {
  await page.evaluate(
    ({ id, opacity }) => {
      const element = document.getElementById(id)
      if (element !== null) element.style.opacity = String(opacity)
    },
    { id: annotationId, opacity },
  )
}

/** Remove an active annotation with a deterministic stepped fade. */
export const clearAnnotation = async (page: Page) => {
  for (let index = 6; index >= 0; index -= 1) {
    await setAnnotationOpacity(page, index / 6)
    await page.waitForTimeout(28)
  }
  await page.evaluate((id) => document.getElementById(id)?.remove(), annotationId)
}

/** Spotlight a target and show a Xenith-style explanatory callout. */
export const annotate = async (
  page: Page,
  target: Locator,
  body: string,
  options: {
    readonly title?: string
    readonly placement?: "top" | "bottom" | "left" | "right"
    readonly hold?: number
  } = {},
) => {
  const { title, placement = "bottom", hold = 2_900 } = options
  await target.scrollIntoViewIfNeeded().catch(() => undefined)
  const box = await target.boundingBox()
  if (box === null) throw new Error("Annotation target has no visible bounds")
  await moveTo(page, target)
  await page.evaluate(
    ({ id, box, body, title, placement }) => {
      document.getElementById(id)?.remove()
      const root = document.createElement("div")
      root.id = id
      root.style.cssText =
        "position:fixed;inset:0;z-index:2147483646;pointer-events:none;opacity:0;" +
        "font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"

      const padding = 6
      const ring = document.createElement("div")
      ring.style.cssText =
        `position:absolute;left:${box.x - padding}px;top:${box.y - padding}px;` +
        `width:${box.width + padding * 2}px;height:${box.height + padding * 2}px;` +
        "border:2.5px solid #2563eb;border-radius:10px;" +
        "box-shadow:0 0 0 4px rgba(37,99,235,.25),0 0 0 9999px rgba(8,14,32,.55);"
      root.append(ring)

      const bubble = document.createElement("div")
      bubble.style.cssText =
        "position:absolute;max-width:420px;background:#0e1836;color:#fff;" +
        "border:1px solid rgba(123,160,255,.35);border-radius:12px;padding:16px 18px;" +
        "box-shadow:0 14px 44px rgba(0,0,0,.55);"
      if (title !== undefined) {
        const eyebrow = document.createElement("div")
        eyebrow.textContent = title
        eyebrow.style.cssText =
          "font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;" +
          "color:#7ba0ff;margin-bottom:6px;"
        bubble.append(eyebrow)
      }
      const copy = document.createElement("div")
      copy.textContent = body
      copy.style.cssText = "font-size:19px;line-height:1.4;"
      bubble.append(copy)
      root.append(bubble)
      document.documentElement.append(root)

      const gap = 16
      const bubbleBox = bubble.getBoundingClientRect()
      let left = box.x
      let top = box.y
      if (placement === "bottom") {
        top = box.y + box.height + gap
        left = box.x + box.width / 2 - bubbleBox.width / 2
      } else if (placement === "top") {
        top = box.y - bubbleBox.height - gap
        left = box.x + box.width / 2 - bubbleBox.width / 2
      } else if (placement === "left") {
        left = box.x - bubbleBox.width - gap
        top = box.y + box.height / 2 - bubbleBox.height / 2
      } else {
        left = box.x + box.width + gap
        top = box.y + box.height / 2 - bubbleBox.height / 2
      }
      const margin = 24
      bubble.style.left = `${Math.max(margin, Math.min(left, innerWidth - bubbleBox.width - margin))}px`
      bubble.style.top = `${Math.max(margin, Math.min(top, innerHeight - bubbleBox.height - margin))}px`
    },
    { id: annotationId, box, body, title, placement },
  )
  for (let index = 0; index <= 6; index += 1) {
    await setAnnotationOpacity(page, index / 6)
    await page.waitForTimeout(28)
  }
  await page.waitForTimeout(hold)
  await clearAnnotation(page)
}
