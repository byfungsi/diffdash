---
description: Guide the automated DiffDash version PR, release tag, GitHub draft, and Cloudflare R2 release flow.
agent: build
---

Use the `diffdash-release` skill and prepare a DiffDash release.

Arguments from the user:

```text
$ARGUMENTS
```

Follow the skill exactly. If the intended Changeset bump is ambiguous, ask one concise question before editing files. Do not create a version commit, merge the version PR, push, tag, or publish a GitHub Release unless the skill requires user approval and the user explicitly asks.
