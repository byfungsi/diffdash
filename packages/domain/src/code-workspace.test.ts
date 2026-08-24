import { describe, expect, it } from "@effect/vitest"
import { Option, Schema } from "effect"

import { CodeWorkspaceLease, CodeWorkspaceLeaseId } from "./code-workspace"
import { ReviewRevision } from "./review-identity"

describe("CodeWorkspaceLease", () => {
  it("normalizes an absent Git revision while preserving the wire encoding", () => {
    const encoded = {
      id: "lease:snapshot",
      revision: "snapshot-digest",
      gitRevision: null,
      expiresAtMs: 1,
    }
    const lease = Schema.decodeUnknownSync(CodeWorkspaceLease)(encoded)

    expect(lease.id).toBe(CodeWorkspaceLeaseId.make("lease:snapshot"))
    expect(lease.revision).toBe(ReviewRevision.make("snapshot-digest"))
    expect(Option.isNone(lease.gitRevision)).toBe(true)
    expect(Schema.encodeSync(CodeWorkspaceLease)(lease)).toEqual(encoded)
  })
})
