# Provider Packages

DiffDash has two provider extension contracts:

- [Git provider authoring](git-provider-authoring.md) covers hosted repository and review providers.
- [Agent provider authoring](agent-provider-authoring.md) covers walkthrough and review-thread agents.

Both SDKs own provider-neutral models, registries, errors, and conformance suites. Concrete providers
are leaf packages imported only by the Electron composition root. See [Architecture](architecture.md)
for the final package graph and allowed dependency directions.

Providers are built into DiffDash initially. They are reviewed, tested, versioned, and released with
the desktop application. Package boundaries enforce ownership and dependency direction; they are not
runtime sandboxing and do not make untrusted provider code safe to execute.

The deterministic `@diffdash/git-provider-fixture` and `@diffdash/agent-provider-fixture` packages
prove that a provider can be introduced with one package and one explicit desktop registration.
Packaged E2E enables those registrations only through test environment flags and exercises discovery,
settings, persistence, hosted Git workspace composition, and agent execution without authentication
or network access.
