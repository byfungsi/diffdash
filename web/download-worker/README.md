# DiffDash Download Worker

Cloudflare Worker for stable download redirects and automatic-update feeds.

Every endpoint resolves the tag in R2 `stable.json`. Uploaded GitHub drafts remain unavailable until `pnpm release:promote` updates that pointer.

## Endpoints

- `https://download.usediffdash.com/macos` redirects to the latest macOS DMG.
- `https://download.usediffdash.com/linux` redirects to the latest Linux deb.
- `https://download.usediffdash.com/linux/appimage` redirects to the latest Linux x64 AppImage.
- `https://download.usediffdash.com/updates/stable/macos/arm64` is the macOS ARM64 updater feed.
- `https://download.usediffdash.com/updates/stable/macos/x64` is the macOS Intel updater feed.
- `https://download.usediffdash.com/updates/stable/linux/x64` is the Linux x64 AppImage updater feed.

Optional macOS architecture override:

```text
https://download.usediffdash.com/macos?arch=x64
https://download.usediffdash.com/macos?arch=arm64
https://download.usediffdash.com/linux/appimage?arch=x86_64
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
- R2 root `stable.json`, written only by `pnpm release:promote`
- Worker routes for `macos*`, `linux*`, and `updates*`, configured in `wrangler.jsonc`
- R2 public custom domain `download.usediffdash.com` for `/releases/...` assets

Use `pnpm dev` for local Wrangler development.
