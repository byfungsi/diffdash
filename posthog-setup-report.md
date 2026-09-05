# Cloud PostHog setup

Implemented anonymous, explicit browser telemetry using the existing DiffDash PostHog environment
configuration and the marketing site's direct ingestion pattern. See [Cloud analytics](docs/cloud-analytics.md)
for configuration, privacy limits, and deployment details. No SDK, autocapture, replay, user identification,
raw exception capture, or automatic URL tracking is enabled.

| Event | Meaning | File |
| --- | --- | --- |
| `cloud_opened` | Browser app started | `packages/cloud/src/main.tsx` |
| `github_connected` | Explicit PAT sign-in succeeded | `packages/cloud/src/cloud-root.tsx` |
| `github_connection_failed` | Explicit PAT verification failed; no error text | `packages/cloud/src/cloud-root.tsx` |
| `github_disconnected` | GitHub disconnected; anonymous identity reset | `packages/cloud/src/cloud-session-extension.tsx` |
| `review_opened` | Shared review-opened event, with review type only | `packages/cloud/src/cloud-analytics.ts` |
| `note_created` | Note persisted | `packages/cloud/src/cloud-api.ts` |
| `note_deleted` | Note deletion completed | `packages/cloud/src/cloud-api.ts` |
| `notes_cleared` | Collection clear completed | `packages/cloud/src/cloud-api.ts` |

Remote dashboards and insights were not created; this change is limited to app integration.
Filter existing-project insights by `app = cloud` to exclude desktop and marketing events.

## Verify before merging

- [ ] Verify a production-configured build emits events into the intended existing PostHog project.
- [ ] Inspect a real ingestion payload and confirm it contains only the documented allowlisted properties.
- [ ] Confirm the deployed Worker CSP permits the configured ingestion region.

No live telemetry was sent to validate the integration. Tests use synthetic ingestion keys and
injected HTTP transports; browser integration tests explicitly disable production analytics.
