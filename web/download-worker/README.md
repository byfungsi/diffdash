# DiffDash Download Worker

Cloudflare Worker for latest download redirects.

It does not read `latest.json`. Each request lists the release artifacts in R2, selects the newest semver release, and redirects to the matching asset with `Cache-Control: no-store`.

## Endpoints

- `https://download.usediffdash.com/macos` redirects to the latest macOS DMG.
- `https://download.usediffdash.com/linux` redirects to the latest Linux deb.

Optional macOS architecture override:

```text
https://download.usediffdash.com/macos?arch=x64
https://download.usediffdash.com/macos?arch=arm64
```

## Local Deploy

```bash
cd web/download-worker
pnpm install
pnpm deploy
```

The worker expects:

- R2 bucket binding `RELEASES_BUCKET`, configured in `wrangler.jsonc`
- R2 bucket `diffdash`, with artifacts under `releases/v*/`
- `PUBLIC_RELEASE_BASE_URL`, configured in `wrangler.jsonc`
- Worker routes `download.usediffdash.com/macos*` and `download.usediffdash.com/linux*`, configured in `wrangler.jsonc`
- R2 public custom domain `download.usediffdash.com` for `/releases/...` assets

Use `pnpm dev` for local Wrangler development.
