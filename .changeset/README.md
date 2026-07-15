# Changesets

Use Changesets to describe user-visible changes before a release.

```bash
pnpm changeset
pnpm release:version
```

`pnpm release:version` updates `packages/desktop/package.json` and
`packages/desktop/CHANGELOG.md`. Commit those files before tagging a release.
