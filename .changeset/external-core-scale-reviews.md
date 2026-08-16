---
"@diffdash/desktop": minor
---

Run application services in one authenticated external Core process and load repository-scale reviews progressively through bounded persisted ranges.

DiffDash qualifies a packaged Bun host when available and otherwise uses Electron's utility-process
host. Host selection ends before Core takes database ownership; runtime failures never fall back to a
second SQLite owner. Git and agent providers now execute in Core rather than Electron.

Review text, syntax output, search state, and rendered containers use independent bounded caches and
are released when the active review changes. Exact immutable Git comparisons may regenerate bounded
ranges lazily, while mutable or remote sources retain a managed spool. Syntax highlighting remains
deferred and oversized or unsupported content can stay in plain-text mode.
