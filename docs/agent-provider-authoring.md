# Agent Provider Authoring

Agent providers adapt one agent runtime to the capability-neutral contracts in
`@diffdash/agent-provider`. Providers are built into DiffDash initially and run as trusted Electron
main-process code; package isolation is not runtime sandboxing.

## Package Template

Create one leaf package named `packages/agent-provider-<name>`:

```json
{
  "name": "@diffdash/agent-provider-<name>",
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
    "@diffdash/agent-provider": "workspace:*",
    "@diffdash/process": "workspace:*",
    "effect": "catalog:"
  }
}
```

Omit `@diffdash/process` for an in-memory provider. A provider may add its official integration
library, but cannot import domain/protocol models, Electron, React, settings, persistence, host
orchestration, MCP server implementation, or another provider. Export one factory returning exactly
one `AgentProviderRegistration`.

`@diffdash/agent-provider-fixture` is the minimal package, manifest, conformance, and packaged
composition proof.

## Manifest

Create an `AgentProviderManifest` containing:

- A stable open `AgentProviderId`, display metadata, and setup requirements.
- Provider-owned model IDs, labels, quality tiers, and capability membership.
- A valid default model for each supported capability and `null` for unsupported capabilities.
- Independent walkthrough and review-thread declarations and automatic priorities. Use `null`
  priority when the provider must be explicitly selected.
- Honest session support: `none` or resumable provider sessions.

The renderer catalog is serialized from this manifest. Do not add hard-coded renderer options or a
second automatic-provider list.

## Capabilities

Implement walkthrough generation, review-thread execution, or both. Each implementation owns its
provider-native probe, policy translation, process/client invocation, protocol parsing, usage
normalization, and cleanup. Runtime availability and enforceable-policy support are separate probe
results.

Execution must honor `AgentExecutionPolicy`, scoped MCP endpoint/token/tool access, selected model,
working directory, timeout, and interruption. Return SDK `WalkthroughResult` or
`ReviewThreadResult` values. Provider artifacts remain candidates; desktop host normalization owns
allowlisting, redaction, bounding, and persistence. Expected failures use bounded SDK errors.

## Desktop Registration

Add a `workspace:*` desktop dependency and import the provider only in
`packages/desktop/electron/main/agent-provider-composition.ts`:

```ts
const registrations: readonly AgentProviderRegistration[] = [
  makeClaudeProvider(shared),
  makeCodexProvider(shared),
  makeOpenCodeProvider(shared),
  makeExampleProvider(shared),
]
return { registrations, policies: agentAutoRoutingPolicies(registrations) }
```

Do not edit registry logic, settings shape, persistence, walkthrough/review orchestration, protocol,
or renderer business logic. `@diffdash/agent-provider-fixture` and its one conditional entry in this
composition array prove that one package plus one explicit desktop registration is sufficient.

## Tests

Use the applicable exports from `@diffdash/agent-provider/testing`:

- `agentManifestConformance` for manifest coherence.
- `walkthroughConformance` and `reviewConformance` for each contributed capability.
- `agentSecurityConformance` for repository immutability, MCP/tool/token isolation, artifact bounds,
  and prohibited patch/file-change output.
- `agentCancellationConformance` when execution acquires a process, server, file, or other resource.

Add deterministic provider-native parser and execution fixtures, malformed-output tests, and cleanup
tests. Never call a real hosted model, require local login, or use network state. Add a parameterized
desktop smoke case for every capability and packaged coverage when final composition changes. Run
the package gates, boundary test, root `pnpm check`, browser/dev/packaged E2E, and build.

## Security

- Enforce non-mutation in the provider-native runtime as well as in the host request.
- Deny publishing, Git mutation, file mutation, sensitive files, shell, network, and MCP tools unless
  the supplied policy explicitly permits them. A provider may enforce a stricter policy.
- Keep MCP bearer tokens redacted and scoped. Never include tokens, prompts, repository content,
  environment secrets, or private paths in logs, errors, usage, or artifacts.
- Parse provider output as untrusted input and fail closed on malformed structures or mutation
  events. Bound output before returning candidates.
- Release subprocesses, temporary files, local servers, sessions, and MCP access on success,
  failure, timeout, and interruption.
- Provider code is trusted main-process code. These controls reduce exposure but do not make an
  untrusted package safe to install.

## Release Policy

Agent providers are private built-ins versioned and shipped with DiffDash, not standalone plugins.
Add a Changeset for user-visible behavior, update the lockfile, and follow `docs/release.md`. New or
changed runtime requirements, models, default routes, automatic priority, permissions, artifacts,
and session behavior require compatibility and security review. The packaged E2E must remain fully
offline through deterministic fixtures.
