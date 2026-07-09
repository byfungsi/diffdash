---
description: Prepare a DiffDash release with Changesets, changelog notes, version tag, and the GitHub/R2 release workflow.
agent: build
---

Use the `diffdash-release` skill and prepare a DiffDash release.

Arguments from the user:

```text
$ARGUMENTS
```

Follow the skill exactly. If the requested version bump or exact version is ambiguous, ask one concise question before editing files. Do not push or create a GitHub Release manually unless the user explicitly asks; the pushed tag triggers the release workflow.
