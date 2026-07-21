# Changesets

Use Changesets to describe user-visible desktop changes before a release. Changesets must target
only `@diffdash/desktop`; internal workspace packages and tools are not independently versioned.

```bash
pnpm changeset
pnpm exec changeset status
```

Use `patch` for fixes and small improvements, `minor` for new capabilities, and `major` only for
explicitly breaking public behavior. Documentation, tests, CI, release automation, and
behavior-neutral refactors normally do not need a Changeset.

After a feature PR merges, `.github/workflows/version.yml` uses `changesets/action` to create or
update the version PR. Do not run `pnpm release:version` during the normal flow. Manually merging
the version PR creates the matching release tag and starts the GitHub Release workflow.
