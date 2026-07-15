# Workspace Topology

DiffDash uses one pnpm workspace and Turborepo task graph.

## Ownership

- `packages/*` contains shipped products and reusable runtime packages. Product packages own their
  manifests, runtime dependencies, build configuration, and distributable assets.
- `tools/*` contains maintained private tooling such as deterministic demos, capture hosts, and
  media generation. Tool output is never shipped with a product.
- `scripts/*` contains repository orchestration only. Product runtime code and reusable libraries do
  not live in scripts.

The migration begins with the existing desktop product at the root so baseline commands remain
stable. `FUN-118` moves product ownership into `packages/*`; after that move, the root manifest owns
only repository-wide tooling and convenience commands.

## Task Policy

Turbo defines shared `build`, `typecheck`, `test`, `lint`, and `dev` tasks. Build outputs are cached;
typecheck and lint have no outputs; development processes are persistent and uncached. Native ABI
rebuilds, packaging, signing, notarization, deployment, and release publication remain explicit
uncached orchestration commands.

Package TypeScript configurations extend `tsconfig.base.json` and add only their environment needs:
Node/Electron packages select Node types and browser packages select DOM libraries and JSX.

## Transitional Commands

Root desktop development, unit, browser, Electron E2E, packaged E2E, and release commands remain
runnable during M9. Turbo convenience commands are additive until product packages own those tasks.
