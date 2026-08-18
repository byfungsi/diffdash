---
"@diffdash/desktop": minor
---

Run application services in one authenticated external Core process and assemble complete review files eagerly from bounded persisted range reads.

DiffDash qualifies a packaged Bun host when available and otherwise uses Electron's utility-process
host. Host selection ends before Core takes database ownership; runtime failures never fall back to a
second SQLite owner. Git and agent providers now execute in Core rather than Electron.

Complete files load with bounded concurrency and remain available for the active review, while Pierre
virtualizes lines within each file. Exact immutable Git comparisons may regenerate bounded ranges
lazily, while mutable or remote sources retain a managed spool. Syntax highlighting remains deferred,
and oversized or unsupported content can stay in plain-text mode.
