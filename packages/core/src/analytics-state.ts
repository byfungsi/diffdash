import { Schema } from "effect"

/** HTTP or HTTPS URL decoded at the native host boundary. */
export const CoreWebUrl = Schema.String.pipe(
  Schema.filter(
    (value) => {
      try {
        const url = new URL(value)
        return url.protocol === "http:" || url.protocol === "https:"
      } catch {
        return false
      }
    },
    { message: () => "Expected an HTTP or HTTPS URL" },
  ),
  Schema.brand("CoreWebUrl"),
)

/** HTTP or HTTPS URL decoded at the native host boundary. */
export type CoreWebUrl = typeof CoreWebUrl.Type

const AnalyticsProjectKey = Schema.String.pipe(Schema.minLength(1))

/** Analytics configuration that cannot produce a client. */
export class CoreAnalyticsDisabled extends Schema.TaggedClass<CoreAnalyticsDisabled>()(
  "disabled",
  {},
) {}

/** Complete analytics configuration required to produce a client. */
export class CoreAnalyticsEnabled extends Schema.TaggedClass<CoreAnalyticsEnabled>()("enabled", {
  host: CoreWebUrl,
  projectKey: AnalyticsProjectKey,
}) {}

const EncodedAnalyticsState = Schema.Struct({
  host: Schema.NullOr(CoreWebUrl),
  projectKey: Schema.NullOr(AnalyticsProjectKey),
})

/**
 * Decodes nullable host configuration into one closed analytics availability state.
 * Partial credentials are intentionally normalized to disabled.
 */
export const CoreAnalyticsState = Schema.transform(
  EncodedAnalyticsState,
  Schema.Union(CoreAnalyticsDisabled, CoreAnalyticsEnabled),
  {
    strict: true,
    decode: ({ host, projectKey }) =>
      host === null || projectKey === null
        ? CoreAnalyticsDisabled.make()
        : CoreAnalyticsEnabled.make({ host, projectKey }),
    encode: (_encodedState, state) =>
      state instanceof CoreAnalyticsDisabled
        ? { host: null, projectKey: null }
        : { host: state.host, projectKey: state.projectKey },
  },
)

/** Closed internal analytics availability state. */
export type CoreAnalyticsState = typeof CoreAnalyticsState.Type
