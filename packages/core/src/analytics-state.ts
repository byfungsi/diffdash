import { Match, Schema, SchemaTransformation } from "effect"
import { WebUrl } from "@diffdash/domain/web-url"

/** HTTP or HTTPS URL decoded at the native host boundary. */
export const CoreWebUrl = WebUrl

/** HTTP or HTTPS URL decoded at the native host boundary. */
export type CoreWebUrl = typeof CoreWebUrl.Type

const AnalyticsProjectKey = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("AnalyticsProjectKey"),
)

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
export const CoreAnalyticsState = EncodedAnalyticsState.pipe(
  Schema.decodeTo(
    Schema.toType(Schema.Union([CoreAnalyticsDisabled, CoreAnalyticsEnabled])),
    SchemaTransformation.transform({
      decode: ({ host, projectKey }) =>
        host === null || projectKey === null
          ? CoreAnalyticsDisabled.make()
          : CoreAnalyticsEnabled.make({ host, projectKey }),
      encode: (state) =>
        Match.value(state).pipe(
          Match.tag("disabled", () => ({ host: null, projectKey: null })),
          Match.tag("enabled", (enabled) => ({
            host: enabled.host,
            projectKey: enabled.projectKey,
          })),
          Match.exhaustive,
        ),
    }),
  ),
)

/** Closed internal analytics availability state. */
export type CoreAnalyticsState = typeof CoreAnalyticsState.Type
