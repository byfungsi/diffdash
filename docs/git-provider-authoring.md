# Git Provider Authoring

Git providers adapt a hosted source-control product to `@diffdash/git-provider`. Providers are
built into DiffDash initially; there is no runtime plugin loader or sandbox.

## Package Template

Create one leaf package named `packages/git-provider-<name>`:

```json
{
  "name": "@diffdash/git-provider-<name>",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/<name>.ts" },
  "scripts": {
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "oxlint src --no-error-on-unmatched-pattern"
  },
  "dependencies": {
    "@diffdash/git-provider": "workspace:*",
    "@diffdash/process": "workspace:*",
    "effect": "catalog:"
  }
}
```

Omit `@diffdash/process` when the provider does not execute a CLI. Add only the provider's official
client library when required. Extend `tsconfig.base.json` and export one factory that returns a
`GitProviderRegistration`.

`@diffdash/git-provider-fixture` is the smallest working package and conformance example.

## Descriptor And Identity

The registration descriptor is the provider manifest. Define:

- A globally unique, stable instance `GitProviderId`. Persisted repository and review keys include
  it, so never rename a shipped ID without a data migration.
- A `GitProviderKind` identifying the implementation family. Multiple configured instances may have
  the same kind but must have different IDs.
- Display name, host, terminology, and truthful capabilities.
- Complete namespace handling. Nested groups must not be flattened.

The built-in GitHub.com instance remains `github`. Provider-specific API and CLI DTOs stay inside the
package and are normalized to SDK/domain values before crossing the export boundary.

## Capabilities

Implement `diagnose` and only advertise operations the registration actually supports:

- Repository search and search scopes.
- Assigned and repository review listing.
- Review detail, diff, immutable revisions, and decisions.
- Repository, file, and review URLs.
- Remote workspace bootstrap and checkout specifications.

Expected authentication, parsing, API, CLI, and capability failures are
`GitProviderOperationError` values. Remote parsing must reject other providers and preserve
self-hosted domains and nested namespaces.

## Desktop Registration

Add the package as a `workspace:*` dependency of `@diffdash/desktop`, import its factory only in
`packages/desktop/electron/main/composition.ts`, and append one registration before constructing
`GitProviderRegistry.layer`:

```ts
const registrations: GitProviderRegistration[] = [
  createGitHubProvider({}, cli),
  createExampleProvider(config, cli),
]
```

Do not add provider branches to the registry, protocol, persistence, renderer, local Git, or host
orchestration. `@diffdash/git-provider-fixture` plus its single conditional registration in desktop
composition proves the one-package plus one-registration path.

## Tests

- Run `gitProviderConformance` from `@diffdash/git-provider/testing` with deterministic remote,
  namespace, repository, and review fixtures.
- Unit test provider-specific parsing, diagnostics, errors, and every advertised capability.
- Add a desktop or packaged E2E smoke flow when composition, persistence, renderer vocabulary, or
  remote workspace behavior changes.
- Use fake provider clients and CLI binaries. Tests must not require credentials, local auth, or
  network access.
- Run `pnpm test:boundaries`, package typecheck/test/lint, root `pnpm check`, browser and Electron E2E,
  packaged E2E, and build before release.

## Security

- Treat remote and API data as untrusted and parse at the package boundary.
- Never log credentials, authorization headers, raw environment secrets, or repository content.
- Pass CLI arguments as arrays; do not construct shell command strings.
- Preserve immutable review revisions and validate provider ownership before every operation.
- Do not mutate the user's checkout. Hosted agent work uses the host-owned isolated workspace pool.
- Provider code is trusted main-process code. Package isolation limits dependencies; it does not
  contain a compromised or malicious provider.

## Release Policy

Providers are private built-in workspace packages and ship only inside a reviewed DiffDash desktop
release. Add a Changeset for user-visible provider behavior, update the lockfile, and follow
`docs/release.md`. A provider is not independently published, dynamically downloaded, or promoted.
Removing or renaming IDs, changing durable identity, or dropping capabilities requires explicit
compatibility and migration review.
