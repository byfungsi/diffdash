# Cloud infrastructure

This private tooling package owns Alchemy deployment for `packages/cloud`. It pins Alchemy
`2.0.0-beta.72` and Effect `4.0.0-rc.109`, matching Fungsi. The browser, shared domain, and desktop
packages retain their existing Effect catalog; no Effect runtime values cross this tooling boundary.

The stack uses `Cloudflare.Website.Vite` with the Cloud Worker entrypoint, SPA assets, and the
`cloud.usediffdash.com` custom domain. Worker-first routing preserves security headers on asset responses.
Rebuild inputs include shared app/domain/protocol sources and the workspace lockfile.

From the repository root:

```sh
pnpm --filter @diffdash/cloud build
pnpm --filter @diffdash/cloud-infrastructure test
pnpm --filter @diffdash/cloud dev
pnpm --filter @diffdash/cloud deploy:dry-run
pnpm --filter @diffdash/cloud run deploy
```

`build` produces `packages/cloud/dist/client` and `dist/ssr` without reading Alchemy deployment state
or contacting Cloudflare. The build test executes the emitted Worker against an asset service fake
and checks that non-public credential environment values do not enter either output.

`dev`, `deploy`, and `deploy:dry-run` default to the existing local `ocha-poc-token-admin` profile.
Override it by setting `ALCHEMY_PROFILE`. `deploy:dry-run` uses Alchemy 2's `plan` command: it can read
remote state, so it is distinct from the offline build. Production remains the `prod` stage.

Credentials remain in the local Alchemy profile. The ignored `packages/cloud/.env.deploy.local` copy
is available for explicit environment authentication but is not automatically loaded or bound to the
Worker. Future application secrets must be explicitly redacted secret bindings in the stack; never
copy the whole process environment into a Worker or prefix secrets with `VITE_`.

The old Alchemy 0.x configuration had not been committed with this Cloud package. This migration does
not automatically import or adopt any pre-existing remote resources. Review the production plan and
resource ownership before the first Alchemy 2 deployment.
