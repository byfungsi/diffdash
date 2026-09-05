# Cloud GitHub OAuth and App installation

Status: superseded by the decision to retain PAT authentication for the web app. OAuth and GitHub
App installation are not planned for the current scope. The proposal below is retained as historical
context, not implementation instructions. Browser-local notes are described in [Web notes](cloud-notes.md).

## Outcome and scope

Replace Cloud's personal access token form with GitHub sign-in through Fungsi's existing OAuth
registration and a connection flow for a new, dedicated DiffDash GitHub App. Users choose an
accessible DiffDash App installation and its repositories, then use
DiffDash's existing read-only PR and diff experience. Comments, review submission, agents, and mobile
packaging are separate work.

Reuse only the OAuth registration and Cloudflare account. Give DiffDash its own GitHub App identity,
App credentials, installations, setup callback, user authorization callback, and webhook endpoint,
alongside separate sessions, cookies, D1 databases, encryption keys, Worker resources, and
infrastructure state. A Fungsi App installation does not grant access to DiffDash. Users must install
the new DiffDash App or connect an existing installation of that new App after access verification.

## Inspected implementation

- DiffDash: `packages/cloud/src/main.tsx`, `github-client.ts`, `github-credentials.ts`,
  `cloud-api.ts`, `cloud-storage.ts`, and `worker/index.ts`.
- Fungsi: `apps/api/src/adapters/better-auth/authentication-server.ts`,
  `configuration/authentication-config.ts`, `configuration/github-app-config.ts`,
  `adapters/http/github-provider-routes.ts`, `github/application/github-connection-service.ts`, and
  `apps/api/alchemy.run.ts`.
- Fungsi uses separate OAuth login credentials and GitHub App user authorization credentials.
  Its login scopes are `read:user` and `user:email`; repository authority is a separate connection.
- Fungsi's App implementation is a design reference only. Its App IDs, client credentials, private
  key, webhook secret, and callback configuration must not be copied into DiffDash.
- The only env file found under Fungsi is `apps/api/.env`, containing two telemetry variables.
  GitHub credentials and Cloudflare deployment credentials were not present there. GitHub credentials
  have not been copied. Fungsi selects the local Alchemy profile `ocha-poc-token-admin`; its stored
  Cloudflare API key, email, and account ID have been copied to ignored
  `packages/cloud/.env.deploy.local` with owner-only `0600` permissions. The source profile is unchanged.
- Cloud deployment now lives in `tools/cloud-infrastructure/alchemy.run.ts`, pinned to Fungsi's
  Alchemy `2.0.0-beta.72` and Effect `4.0.0-rc.109`. Cloud application code retains the shared
  application Effect version; keep runtime values within their package/runtime boundary.

## OAuth and dedicated App registration

Use `https://diffshub.com` as the proposed production origin, matching current Cloud infrastructure.
Verify live registration settings before changing them; none have been changed during planning.

1. Add the DiffDash OAuth callback, proposed `/api/auth/callback/github`, while preserving all Fungsi
   callbacks. Explicitly send the selected `redirect_uri`. Current GitHub documentation permits up to
   ten OAuth callback URLs; verify the existing registration supports the intended configuration.
2. Register a new GitHub App for DiffDash. Set its homepage to `https://diffshub.com`, user
   authorization callback to `/api/github/user-authorization/callback`, setup URL to
   `/api/github/setup/callback`, and webhook URL to `/api/github/webhooks`, all on that origin.
   Generate new App credentials, a private key, and a webhook secret. Record the actual App ID and
   available slug after registration; no name or slug has been reserved yet.
3. Keep installation setup and user authorization as distinct steps. Use the dedicated setup URL
   with one-time state to resume the DiffDash connection flow after installation, then complete App
   user authorization and verify installation access. Do not enable GitHub's combined OAuth-on-install
   option for this flow, since it replaces setup-URL routing. Never trust an installation ID from a
   query string. Existing DiffDash installations should be discoverable without reinstalling.
4. Scope the new App's initial permissions to the existing read-only repository/PR/diff workflow.
   Verify each required GitHub endpoint's permissions during implementation; defer write permissions
   until a feature needs them. Handle installation and selected-repository lifecycle webhooks directly
   in DiffDash, with signature verification and idempotency by delivery ID. Reconcile on reconnect
   and provider denial as well; webhook receipt alone is not current user authorization.
5. Disconnect unlinks the repository connection in DiffDash. Offer App installation management as a
   separate explicit action. Logging out or disconnecting repository access must not revoke the
   shared Fungsi OAuth grant. Fungsi's App settings, installations, and webhook remain independent;
   no shared setup dispatcher or webhook forwarding is needed.

GitHub remains authoritative for accessible installations, selected repositories, and user access.
App user tokens constrain access to what both the user and installation can access. If background
installation tokens become necessary, independently authorize the user and narrow each token to the
required repositories and permissions; possessing the App key is not end-user authorization.

## Architecture and user flow

Browser -> same-origin DiffDash Worker -> GitHub and DiffDash-owned D1 storage.

The Worker owns OAuth exchanges, session validation, encrypted token custody and refresh, GitHub
requests, and safe error projection. The browser receives encoded product values and an HttpOnly
session cookie. Client IDs may be public, but provider tokens, client secrets, private keys, session
secrets, and CF credentials never enter browser modules or `VITE_*` configuration.

1. **Sign in with GitHub:** establish a DiffDash session with the existing OAuth registration.
2. **Connect repositories:** authorize the dedicated DiffDash GitHub App; verify its GitHub user ID matches the
   signed-in GitHub account, then list accessible installations and repositories.
3. **Install or manage access:** open the DiffDash App's GitHub installation flow when no suitable
   installation/repository is available. Resume through the dedicated setup callback and recheck
   access instead of assuming installation succeeded. Explain when organization approval is pending.
4. **Review:** use bounded, named Worker routes for the existing repository, PR, and diff operations.
   Do not introduce an unrestricted GitHub URL proxy.
5. **Reconnect or disconnect:** show explicit expired, revoked, suspended, pending approval, and
   signed-out states. Clear account-scoped data and pending requests when the account changes.

Use server-owned one-time expiring state for both OAuth flows, fixed allowlisted redirects, secure
session cookies, and origin/CSRF checks for mutations. Refresh tokens through serialized durable
ownership so concurrent requests cannot reuse rotating refresh tokens. Never log callback codes,
token responses, private keys, or raw environment configuration.

The existing shared renderer protocol remains the UI boundary. Move GitHub network access out of the
browser into the Cloud Worker adapter, retain schema-encoded results, and keep Electron and local
CLI integrations unchanged. Review the package-boundary rules for the new Worker/provider ownership.

## Implementation slices and acceptance criteria

1. **Credentials and infrastructure:** locate and copy only Fungsi's OAuth login credentials;
   retain the copied CF deployment credentials. Register the new DiffDash App and store its newly
   generated credentials in ignored files with owner-only permissions. Generate separate DiffDash
   session/encryption secrets and provision separate D1 resources. Prove env files and
   local Alchemy/Wrangler state are ignored; verify secret Worker bindings and browser bundle output.
2. **Login:** introduce Worker-backed sessions and the GitHub sign-in screen. Test successful login,
   cancellation, invalid/expired/replayed state, redirect rejection, logout, and account switching.
   Verify that adding DiffDash's callback preserves Fungsi login and that DiffDash logout does not
   revoke the shared OAuth grant.
3. **App connections:** implement user authorization, installation discovery, and repository selection.
   Test identity mismatch, spoofed installation IDs, new and existing DiffDash installations,
   pending organization approval, denied access, and rejection of Fungsi App installations.
   Test setup-state expiry/replay, invalid webhook signatures, duplicate deliveries, installation
   suspension/removal, repository removal, and independent disconnect behavior.
4. **Provider migration:** route existing PR/diff reads through the Worker. Test pagination, large and
   unavailable diffs, rate limits, token expiry/refresh races, repository removal, and cross-user access.
   Remove the PAT form and delete the legacy browser PAT on migration. Treat old browser review state
   as unowned: import only after access checks and user choice, or discard it; do not expose it to a
   different signed-in account.
5. **Verification and rollout:** run focused service tests with fake GitHub boundaries, Worker/D1
   integration tests, and headless browser sign-in-to-diff tests with deterministic callbacks. Complete
   the repository's required checks for the implemented changes. Separately verify actual OAuth and
   App redirects against registered production URLs. Verify Fungsi login still works and its App
   registration, installations, and webhook settings were not changed.

Completed work consists of planning/configuration examples, Git exclusions, a local copy of the
Cloudflare credentials, and the Alchemy 2 tooling migration. OAuth implementation, OAuth credential
migration, new App registration, deployed bindings, and end-to-end auth remain unverified.
No deployment, Git commit, or GitHub
publication is part of the completed work.

## Credential handling

`packages/cloud/.env.example` contains variable names and proposed public URLs only. Runtime secrets
will live in an ignored local `.env` or `.dev.vars` file; use one convention supported by the pinned
tooling, not both. Deployment credentials belong in a separate ignored `.env.deploy.local` loaded
only by deployment tooling. Reuse Fungsi values only for `GITHUB_OAUTH_CLIENT_ID` and
`GITHUB_OAUTH_CLIENT_SECRET`; populate every `GITHUB_APP_*` credential from the new DiffDash App.
Keep Fungsi App credentials, origins, telemetry, runtime tokens, database IDs, session keys, and
encryption keys out of the credential copy.

Deploy application secrets using Cloudflare secret bindings. Do not put them in plaintext Worker
vars, committed examples, generated client config, build logs, source maps, or infrastructure output.
Git exclusions protect ordinary staging, but verify staged content and client bundles before release;
they do not undo a previously tracked secret or prevent an explicit force-add.

## References

- [OAuth registration and callback URLs](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
- [GitHub App user authorization callbacks](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url)
- [Installation setup and identity verification](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)
- [GitHub App user access](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)
- [GitHub App webhook ownership](https://docs.github.com/en/webhooks/types-of-webhooks)
- [Cloudflare local and deployed secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
