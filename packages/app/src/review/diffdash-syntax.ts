import { DIFFDASH_DARK_CODE_THEME } from "@diffdash/domain/ai-settings"
import {
  registerCustomLanguage,
  registerCustomTheme,
  RegisteredCustomLanguages,
  resolveLanguage,
  resolveTheme,
  type LanguageRegistration,
} from "@pierre/diffs"

const JSON_KEY_PATTERN = {
  match: '"(?:\\\\.|[^"\\\\])*"(?=\\s*:)',
  name: "support.type.property-name.json",
}

const YAML_KEY_PATTERNS = [
  {
    match: '"(?:\\\\.|[^"\\\\])*"(?=\\s*:)',
    name: "entity.name.tag.yaml",
  },
  {
    match: "'(?:''|[^'])*'(?=\\s*:)",
    name: "entity.name.tag.yaml",
  },
]

let syntaxRegistered = false

const prependLanguagePatterns = (
  languages: readonly LanguageRegistration[],
  name: string,
  patterns: readonly { readonly match: string; readonly name: string }[],
): LanguageRegistration[] =>
  languages.map((language, index) =>
    index === 0
      ? {
          ...language,
          name,
          patterns: [...patterns, ...(language.patterns ?? [])],
        }
      : language,
  )

const loadJsonLanguage = async () => {
  const language = await resolveLanguage("json")
  return {
    default: prependLanguagePatterns(language.data, "diffdash-json", [JSON_KEY_PATTERN]),
  }
}

const loadJsoncLanguage = async () => {
  const language = await resolveLanguage("jsonc")
  return {
    default: prependLanguagePatterns(language.data, "diffdash-jsonc", [JSON_KEY_PATTERN]),
  }
}

const loadYamlLanguage = async () => {
  const language = await resolveLanguage("yaml")
  return {
    default: prependLanguagePatterns(language.data, "diffdash-yaml", YAML_KEY_PATTERNS),
  }
}

const loadDiffDashDarkTheme = async () => {
  const theme = await resolveTheme("pierre-dark-soft")
  const foreground = "#bcbcc4"
  return {
    ...theme,
    name: DIFFDASH_DARK_CODE_THEME,
    displayName: "DiffDash Dark",
    fg: foreground,
    colors: {
      ...theme.colors,
      "editor.foreground": foreground,
      foreground,
    },
    settings: [
      ...theme.settings,
      {
        scope: [
          "entity.name.tag.tsx",
          "punctuation.definition.tag.begin.tsx",
          "punctuation.definition.tag.end.tsx",
        ],
        settings: { foreground: "#68cdf2" },
      },
      {
        scope: "support.class.component.tsx",
        settings: { foreground: "#e290f0" },
      },
      {
        scope: "entity.other.attribute-name.tsx",
        settings: { foreground: "#ffde80" },
      },
      {
        scope: [
          "support.type.property-name.json",
          "support.type.property-name.json punctuation",
          "entity.name.tag.yaml",
        ],
        settings: { foreground: "#ffa685" },
      },
    ],
  }
}

/** Registers DiffDash's syntax theme and line-local structured-data grammars once per renderer. */
export const registerDiffDashSyntax = (): void => {
  if (syntaxRegistered) return
  syntaxRegistered = true

  registerCustomTheme(DIFFDASH_DARK_CODE_THEME, loadDiffDashDarkTheme)
  if (!RegisteredCustomLanguages.has("diffdash-json")) {
    registerCustomLanguage("diffdash-json", loadJsonLanguage, ["json"])
  }
  if (!RegisteredCustomLanguages.has("diffdash-jsonc")) {
    registerCustomLanguage("diffdash-jsonc", loadJsoncLanguage, ["jsonc"])
  }
  if (!RegisteredCustomLanguages.has("diffdash-yaml")) {
    registerCustomLanguage("diffdash-yaml", loadYamlLanguage, ["yaml", "yml"])
  }
}
