# Cloud analytics

Cloud uses the existing DiffDash PostHog project with `app: cloud`. Like the marketing site,
it sends explicit events to PostHog's capture endpoint without loading the browser SDK.
There is no autocapture, session replay, automatic pageview, exception capture, or GitHub identification.

Configuration is build-time: `VITE_POSTHOG_KEY` (public project ingestion key, not a personal API key)
and `VITE_POSTHOG_HOST`. Cloud configuration takes precedence over repository-root configuration,
then the marketing site's configuration. Supported hosts are `https://us.i.posthog.com` and
`https://eu.i.posthog.com`; both are allowed by the Worker's connect-src CSP. Missing configuration
disables analytics. Restart Vite or rebuild after changing configuration. No deployment is required
to test locally, but configured local development sends real events. Automated browser tests override
these values to empty strings.

Events are catalogued in `posthog-setup-report.md`. Review events carry only the review type; other
events carry no business properties. No repository names, SHAs, URLs, PATs, notes, source code,
GitHub usernames, or raw errors are sent. Requests omit credentials and referrers, disable GeoIP
enrichment and person-profile processing, and use an anonymous browser ID reset on disconnect.
The ingestion service still necessarily receives the connection's IP address.

Note copy is not tracked: it currently lives in shared UI rather than the web platform adapter.
Authentication failures are counted without exception details. The asset-only Worker performs no
business operations and emits no server-side events. Delivery is best-effort, without retries;
analytics failure never blocks application work. No remote dashboards or project settings are changed.
