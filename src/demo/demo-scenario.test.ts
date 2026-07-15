import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { getHiddenDiffFileReason } from "../../packages/desktop/src/shared/diff-file-filters"
import { isReviewAnchorInParsedDiff } from "../../packages/desktop/src/shared/review-thread"
import { WALKTHROUGH_PROMPT_VERSION } from "../../packages/desktop/src/shared/walkthrough"
import { loadAtomicWebhookReplayScenario } from "./atomic-webhook-replay"

describe("atomic webhook replay demo scenario", () => {
  it.effect("materializes realistic coherent revisions through production parsers", () =>
    Effect.gen(function* () {
      const scenario = yield* loadAtomicWebhookReplayScenario

      expect(scenario.repository.id).toBe("github:emberline/dispatch")
      expect(scenario.revisions).toHaveLength(2)
      expect(scenario.currentRevision.id).toBe("02-database-clock")
      expect(scenario.currentRevision.parsedDiff.files).toHaveLength(9)
      expect(scenario.currentRevision.detail.files).toEqual(
        scenario.currentRevision.parsedDiff.files.map((file) =>
          expect.objectContaining({
            path: file.path,
            additions: file.additions,
            deletions: file.deletions,
          }),
        ),
      )
      expect(scenario.currentRevision.walkthrough.promptVersion).toBe(WALKTHROUGH_PROMPT_VERSION)
      expect(
        scenario.currentRevision.parsedDiff.files
          .filter((file) => getHiddenDiffFileReason(file) !== null)
          .map((file) => file.path),
      ).toEqual(["docs/images/webhook-replay-lifecycle.png", "pnpm-lock.yaml"])
    }),
  )

  it.effect("carries a real line thread across the database-clock revision", () =>
    Effect.gen(function* () {
      const scenario = yield* loadAtomicWebhookReplayScenario
      const details = scenario.threads[0]

      expect(details).toBeDefined()
      if (details === undefined) return

      expect(details.thread.anchorStatus).toBe("active")
      expect(details.thread.headRevision).not.toBe(details.thread.currentHeadRevision)
      expect(details.thread.currentAnchor?.lineContent).toBe(
        "     WHERE replay_claim.claimed_until < excluded.claimed_at",
      )
      expect(details.thread.currentAnchor).not.toBeNull()
      if (details.thread.currentAnchor !== null) {
        expect(
          isReviewAnchorInParsedDiff(
            details.thread.currentAnchor,
            scenario.currentRevision.parsedDiff,
          ),
        ).toBe(true)
      }
      expect(details.messages).toHaveLength(4)
      expect(scenario.agentTurns["turn-lease-follow-up"]?.progress.at(-1)?.event.stage).toBe(
        "restoring-workspace",
      )
    }),
  )

  it.effect("loads with stable IDs and timestamps", () =>
    Effect.gen(function* () {
      const first = yield* loadAtomicWebhookReplayScenario
      const second = yield* loadAtomicWebhookReplayScenario

      expect(second.currentRevision.snapshot.headRevision).toBe(
        first.currentRevision.snapshot.headRevision,
      )
      expect(second.threads[0]?.thread.id).toBe(first.threads[0]?.thread.id)
      expect(second.threads[0]?.thread.createdAt).toBe(first.threads[0]?.thread.createdAt)
    }),
  )
})
