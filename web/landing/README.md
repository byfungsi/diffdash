# DiffDash Landing

Promotional website for DiffDash, served from Cloudflare at `usediffdash.com`.

## Local Development

```bash
pnpm install
pnpm dev
```

## Deploy

Deploy locally with Wrangler:

```bash
pnpm deploy
```

This runs the Vite production build and deploys `dist/` as Cloudflare Worker static assets.
The Worker redirects HTTP requests to HTTPS before serving the static assets.
`run_worker_first` is enabled so the redirect and security headers run before Cloudflare serves assets.

Configured routes:

- `https://usediffdash.com`
- `https://www.usediffdash.com`

The download buttons point to the separate download Worker at `download.usediffdash.com`.

## Analytics

PostHog is optional and configured at build time. The landing page uses PostHog's Capture API directly with `navigator.sendBeacon` so download clicks can be sent before the browser leaves the page.

```bash
VITE_POSTHOG_KEY=phc_...
VITE_POSTHOG_HOST=https://us.i.posthog.com
```

Tracked events:

- `$pageview`
- `download_button_clicked` with `platform`, `placement`, `href`, `path`, `url`, and `title`

Validate without publishing:

```bash
pnpm deploy:dry-run
```
