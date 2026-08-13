import { Schema } from "effect"

/** HTTP or HTTPS URL safe to pass across application and native-host boundaries. */
export const WebUrl = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        try {
          const url = new URL(value)
          return url.protocol === "http:" || url.protocol === "https:"
        } catch {
          return false
        }
      },
      { message: "Expected an HTTP or HTTPS URL" },
    ),
  ),
  Schema.brand("WebUrl"),
)

/** HTTP or HTTPS URL safe to pass across application and native-host boundaries. */
export type WebUrl = typeof WebUrl.Type
