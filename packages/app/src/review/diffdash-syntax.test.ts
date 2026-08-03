import { describe, expect, it } from "@effect/vitest"
import { RegisteredCustomLanguages, resolveTheme } from "@pierre/diffs"
import { registerDiffDashSyntax } from "./diffdash-syntax"

describe("DiffDash syntax registration", () => {
  it("derives a clearer TSX palette from Pierre Dark Soft", async () => {
    registerDiffDashSyntax()
    const theme = await resolveTheme("diffdash-dark")
    const finalForegroundFor = (scope: string) => {
      let foreground: string | undefined
      for (const setting of theme.settings) {
        if (setting.scope === scope) foreground = setting.settings.foreground
      }
      return foreground
    }

    expect(theme.fg).toBe("#bcbcc4")
    expect(theme.colors?.["editor.foreground"]).toBe("#bcbcc4")
    expect(finalForegroundFor("support.class.component.tsx")).toBe("#e290f0")
    expect(finalForegroundFor("entity.other.attribute-name.tsx")).toBe("#ffde80")
  })

  it("prepends line-local key recognition for JSON, JSONC, YAML, and YML", async () => {
    registerDiffDashSyntax()
    const jsonLoader = RegisteredCustomLanguages.get("diffdash-json")
    const jsoncLoader = RegisteredCustomLanguages.get("diffdash-jsonc")
    const yamlLoader = RegisteredCustomLanguages.get("diffdash-yaml")
    expect(jsonLoader).not.toBeUndefined()
    expect(jsoncLoader).not.toBeUndefined()
    expect(yamlLoader).not.toBeUndefined()
    if (jsonLoader === undefined || jsoncLoader === undefined || yamlLoader === undefined) {
      throw new Error("DiffDash syntax language registration was not installed")
    }

    const [json, jsonc, yaml] = await Promise.all([jsonLoader(), jsoncLoader(), yamlLoader()])
    expect(json.default[0]?.patterns?.[0]).toMatchObject({
      name: "support.type.property-name.json",
    })
    expect(jsonc.default[0]?.patterns?.[0]).toMatchObject({
      name: "support.type.property-name.json",
    })
    expect(yaml.default[0]?.patterns?.slice(0, 2)).toEqual([
      expect.objectContaining({ name: "entity.name.tag.yaml" }),
      expect.objectContaining({ name: "entity.name.tag.yaml" }),
    ])
  })
})
