# Cloud review URLs

Cloud accepts GitHub-compatible core review paths. Replace `github.com` with the Cloud origin
(`diffshub.com` when deployed, or your local Vite origin) without changing these paths:

| Path | Destination |
| --- | --- |
| `/owner/repo` or `/owner/repo/pulls` | Open pull requests |
| `/owner/repo/pull/123` | Pull request overview, including closed PRs fetched by number |
| `/owner/repo/pull/123/files` | Pull request diff |
| `/owner/repo/commit/abcdef1234567` | Commit diff against its first parent |
| `/owner/repo/compare/main...feature` | Three-dot comparison using the resolved merge base |

Comparison refs can contain slashes, either literal or percent-encoded. Branches and tags resolve
to immutable SHAs before fetching comparison diffs. A refreshed URL resolves moving refs again.
PAT sign-in retains the original URL; the route opens after authentication. Opening a PR or its
diff updates the address bar. Browser Back/Forward resolves the selected history URL without
pushing another entry. Invalid or unavailable routes display errors rather than a different review.

## Deliberately outside this first slice

- File/line fragments and query-driven view options are not interpreted. An initial URL retains
  them, but navigating to another review generates a core path without them.
- PR commits/checks tabs, commit lists, two-dot comparisons, cross-fork comparison selectors,
  and GitHub pages unrelated to reviews are unsupported.
- Root commits cannot be represented by the current commit-to-commit comparison target. They
  display an explicit unsupported message rather than an invented parent.
- GitHub comments and write actions remain unsupported. [Web notes](cloud-notes.md) are stored
  locally in IndexedDB and can be copied without posting anything to GitHub.
- This change does not deploy Cloud or implement OAuth.

## Ownership

`packages/cloud/src/cloud-review-route.ts` owns GitHub path parsing and formatting.
`cloud-navigation.ts` resolves routes using `GithubClient`, ignores superseded requests, and owns
browser history synchronization. `cloud-root.tsx` gates this behind PAT authentication and renders
route-resolution failures.

The shared app accepts an optional in-process `ApplicationNavigation` adapter. Its shell validates
registered contribution/activity ownership without interpreting review state. The Review extension
creates and reads its own encoded locations and persists the hosted `files` view. Desktop omits the
browser adapter and retains its existing navigation mechanisms.

## Verification

```sh
pnpm --filter @diffdash/cloud test
pnpm --filter @diffdash/cloud test:browser
pnpm --filter @diffdash/cloud typecheck
```

Tests use fake GitHub HTTP responses, the real Cloud bridge, IndexedDB, shared app, and headless
Chromium. They cover route parsing, pinned comparison requests, direct PR/files/commit/compare
loads, native browser Back/Forward, and retention through PAT sign-in and authenticated remount.
Live GitHub credentials and deployed Cloudflare routes are not exercised by these fixtures.
