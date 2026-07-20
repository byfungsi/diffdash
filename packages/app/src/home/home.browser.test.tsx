import { describe, expect, it } from "vitest"
import { appBrowserScenario } from "@/test/app-browser-support"

describe("App home browser interactions", () => {
  it("covers FUN-40/FUN-42/FUN-41/FUN-25/FUN-26 criteria from Home to Review", async () => {
    expect.hasAssertions()
    await appBrowserScenario("homeToReview")()
  })
})
