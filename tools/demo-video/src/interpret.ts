/* eslint-disable no-await-in-loop, no-underscore-dangle -- Demo actions are intentionally sequential and the timeline name is an established browser contract. */
import type { Locator, Page } from "playwright"

import type { Step, Target } from "./framework"
import * as human from "./human"

/** Resolve a human-readable target through Playwright's accessible locator APIs. */
export const locate = (page: Page, target: Target): Locator => {
  if (typeof target === "string") {
    return page
      .getByRole("button", { name: target })
      .or(page.getByRole("link", { name: target }))
      .or(page.getByRole("tab", { name: target }))
      .or(page.getByRole("menuitem", { name: target }))
      .or(page.getByText(target))
      .first()
  }
  if ("button" in target)
    return page.getByRole("button", { name: target.button, exact: target.exact ?? false })
  if ("textbox" in target)
    return page.getByRole("textbox", { name: target.textbox, exact: target.exact ?? false })
  if ("placeholder" in target)
    return page.getByPlaceholder(target.placeholder, { exact: target.exact ?? false })
  if ("text" in target) return page.getByText(target.text, { exact: target.exact ?? false }).first()
  if ("testId" in target) return page.getByTestId(target.testId)
  if ("css" in target) return page.locator(target.css)
  const role = target.role as Parameters<Page["getByRole"]>[0]
  return target.name === undefined
    ? page.getByRole(role)
    : page.getByRole(role, { name: target.name, exact: target.exact ?? false })
}

/** Execute a clip's direct Playwright operations in authored order. */
export const runSteps = async (page: Page, steps: readonly Step[]) => {
  for (const step of steps) {
    switch (step.kind) {
      case "click":
        await human.click(page, locate(page, step.target))
        break
      case "type":
        await human.type(page, locate(page, step.target), step.text)
        break
      case "press":
        await locate(page, step.target).press(step.key)
        await human.pause(page, 250, 450)
        break
      case "annotate":
        await human.annotate(page, locate(page, step.target), step.body, step)
        break
      case "pause":
        await human.pause(page, step.ms, step.ms)
        break
      case "wait":
        await locate(page, step.target).waitFor({
          state: "visible",
          timeout: step.timeout ?? 15_000,
        })
        break
      case "release":
        await page.evaluate(
          (checkpoint) => window.__diffDashDemo.release(checkpoint),
          step.checkpoint,
        )
        break
      case "raw":
        await step.run({ page })
        break
    }
  }
}
