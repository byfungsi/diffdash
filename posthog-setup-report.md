<wizard-report>
# PostHog post-wizard report

The wizard has completed integration of PostHog analytics into the DiffDash landing page. The project already had a custom lightweight analytics module (`packages/web/src/analytics.ts`) that sends events directly to PostHog's capture API using `sendBeacon` / `fetch` with `keepalive` — a deliberately minimal approach suitable for a one-page landing site deployed on Cloudflare Workers. The wizard preserved this implementation, set up the required environment variables, and added one new event to track navigation intent.

| Event | Description | File |
|---|---|---|
| `$pageview` | Fired on initial page load to record each landing page visit. | `packages/web/src/main.tsx` (via `initAnalytics()`) |
| `download_button_clicked` | Fired when any download CTA is clicked; carries `platform` (`macos`, `linux_appimage`, or `linux_deb`), `placement` (hero/footer), and `href`. | `packages/web/src/App.tsx` |
| `nav_link_clicked` | Fired when a navigation anchor link is clicked; carries `section` (workflow/privacy/download) to measure which sections attract interest. | `packages/web/src/App.tsx` |

## Next steps

We've built a dashboard with five insights to keep an eye on download conversions and user behavior:

- **Dashboard:** [Analytics basics (wizard)](https://us.posthog.com/project/505977/dashboard/1827361)
- [Downloads over time](https://us.posthog.com/project/505977/insights/yddrb7NR) — daily download click volume
- [Downloads by platform](https://us.posthog.com/project/505977/insights/oK3lDJKm) — macOS, Linux AppImage, and Debian/Ubuntu split
- [Downloads by CTA placement](https://us.posthog.com/project/505977/insights/oVJuSX10) — hero vs. footer CTA effectiveness
- [Navigation section interest](https://us.posthog.com/project/505977/insights/rQ2bjeTu) — which sections users navigate to
- [Page visit → download conversion funnel](https://us.posthog.com/project/505977/insights/ndAqeLeW) — overall landing page conversion rate

## Verify before merging

- [ ] Run a full production build (`pnpm --filter @diffdash/web build`) and fix any lint or type errors introduced by the generated code.
- [ ] Run the test suite — call sites that were rewritten or instrumented may need updated mocks or fixtures.
- [ ] Add `VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST` to `packages/web/.env.example` (they are already present there) and confirm any CI/CD or Cloudflare Pages environment configuration includes both variables so events are sent from deployed previews and production.
- [ ] Wire source-map upload (`posthog-cli sourcemap` or your bundler's upload step) into CI so production stack traces de-minify.

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
