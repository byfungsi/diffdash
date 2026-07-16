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
