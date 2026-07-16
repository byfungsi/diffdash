# Provider Packages

Hosted Git integrations are leaf packages built against `@diffdash/git-provider`. A provider may
depend on the SDK, `@diffdash/domain`, `@diffdash/process`, and provider-owned client libraries. It
must not import Electron, React, SQLite, persistence adapters, desktop composition, or another
concrete provider.

Each configured instance exports a `GitProviderRegistration` with a globally unique `GitProviderId`.
The ID identifies configuration, while `GitProviderKind` identifies the implementation family. Keep
the built-in GitHub.com instance ID as `github` because repository and review keys are persisted.

Provider packages normalize remote URLs, repository metadata, reviews, decisions, diagnostics, and
checkout specifications into SDK/domain models. They must preserve nested namespaces and configured
self-hosted domains. Provider-specific API responses and command output must not cross the package
boundary.

Concrete packages should invoke `gitProviderConformance` from `@diffdash/git-provider/testing` in
their tests. Only desktop composition imports concrete providers and passes registrations to
`GitProviderRegistry.layer`. Registry/runtime source never imports provider implementations.

## Compatibility

Database schema version 8 already stores hosted identity as the provider instance ID plus `owner`
and `name`. The owner column carries the complete provider namespace, including nested segments.
The canonical repository key remains `<provider-id>:<namespace>/<name>` and the review key appends
`#<number>`. The built-in GitHub.com ID therefore remains `github`; opening a populated v8 database
does not rewrite repositories, pull requests, viewed files, walkthroughs, threads, messages, agent
runs, artifacts, or thread memory. No schema migration is required to add another provider.

Provider IDs identify configured instances, while provider kinds identify implementations. Two
instances of the same kind are valid, but duplicate IDs fail registry construction. The same
namespace and repository name on different IDs produce different durable keys.

`@diffdash/git-provider-fixture` is the non-GitHub contract proof. It depends only on the provider
SDK and Effect, passes the shared conformance suite, and is registered for Electron E2E only in
`packages/desktop/electron/main/index.ts`. Its merge-request vocabulary and disabled decision
capability flow through the existing protocol and renderer without provider-specific branches.

## Adding A Provider

A future GitLab integration requires:

1. A leaf package such as `@diffdash/git-provider-gitlab` implementing `GitProviderRegistration`
   and running `gitProviderConformance`.
2. Its package dependency and one registration in desktop composition.

It must not require changes to persistence, renderer business logic, protocol routing, the SDK
registry, or an existing concrete provider. `scripts/package-boundaries.test.mjs` discovers all
`@diffdash/git-provider-*` packages and enforces that leaf and composition boundary.

## Worktree Manifest Migration

Hosted review workspaces are disposable caches, not durable review data. Manifest v2 scopes remote
repositories and slots by the full provider-aware repository key. When the workspace pool reads a
v1 manifest, it removes the old repository cache, discards the v1 slots, and writes a fresh v2
manifest before preparing the requested review. The source checkout and the SQLite database are not
modified. This invalidation is intentional because old slots cannot be assigned a trustworthy
provider instance; repositories are cloned or copied again on demand at the exact review revision.
