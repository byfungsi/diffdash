import { describe, expect, it } from "vitest"
import { desktopMainEntryForMode } from "./electron-build-configuration"

describe("desktop main build composition", () => {
  it("uses the production entrypoint for every normal build mode", () => {
    expect(desktopMainEntryForMode("production")).toBe("electron/main/index.ts")
    expect(desktopMainEntryForMode("development")).toBe("electron/main/index.ts")
    expect(desktopMainEntryForMode("test")).toBe("electron/main/index.ts")
  })

  it("uses the E2E entrypoint only for the explicit E2E build mode", () => {
    expect(desktopMainEntryForMode("e2e")).toBe("electron/main/index.e2e.ts")
  })
})
