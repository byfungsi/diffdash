import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { DiffFileVisibility } from "@diffdash/domain/diff"
import { isReviewAnchorInParsedDiff } from "@diffdash/domain/review-thread"
import { WALKTHROUGH_PROMPT_VERSION } from "@diffdash/domain/walkthrough"
import initialDiff from "../scenarios/atomic-webhook-replay/revisions/01-initial/unified.diff?raw"
import initialWalkthrough from "../scenarios/atomic-webhook-replay/revisions/01-initial/walkthrough.json?raw"
import databaseClockDiff from "../scenarios/atomic-webhook-replay/revisions/02-database-clock/unified.diff?raw"
import databaseClockWalkthrough from "../scenarios/atomic-webhook-replay/revisions/02-database-clock/walkthrough.json?raw"
import { loadAtomicWebhookReplayScenario } from "./atomic-webhook-replay"
import {
  decodeDemoJson,
  DemoScenarioManifest,
  DemoThreadMessageSource,
  DemoThreadSource,
  DemoWalkthroughSource,
  materializeDemoScenario,
} from "./demo-scenario"
import { makeDemoReviewTurn, validateDemoReviewMessage } from "./review-thread-fixtures"

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
          .filter((file) => DiffFileVisibility.guards.Hidden(file.visibility))
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

      expect(details.thread.currentAnchor._tag).toBe("Active")
      expect(details.thread.headRevision).not.toBe(details.thread.currentHeadRevision)
      expect(details.thread.activeAnchor?.lineContent).toBe(
        "     WHERE replay_claim.claimed_until < excluded.claimed_at",
      )
      expect(details.thread.activeAnchor).not.toBeNull()
      if (details.thread.activeAnchor !== null) {
        expect(
          isReviewAnchorInParsedDiff(
            details.thread.activeAnchor,
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

  it.effect("preserves authored user, pending, and failed turn lifecycle states", () =>
    Effect.gen(function* () {
      const scenario = yield* loadAtomicWebhookReplayScenario
      const thread = scenario.threads[0]?.thread
      expect(thread).toBeDefined()
      if (thread === undefined) return
      const message = {
        id: "lifecycle-message",
        sequence: 4,
        bodyMarkdown: "",
        author: "agent" as const,
        status: "pending" as const,
        agentRunId: "lifecycle-run",
        createdAt: "2026-07-10T08:19:00Z",
        updatedAt: "2026-07-10T08:19:00Z",
      }

      expect(makeDemoReviewTurn(thread, message)).toMatchObject({ _tag: "Pending" })
      expect(
        makeDemoReviewTurn(thread, {
          ...message,
          status: "failed",
          bodyMarkdown: "Provider process exited before producing a response.",
        }),
      ).toMatchObject({ _tag: "Failed" })
      expect(
        makeDemoReviewTurn(thread, {
          ...message,
          author: "user",
          status: "complete",
          agentRunId: null,
          bodyMarkdown: "Please check the retry path.",
        }),
      ).toMatchObject({ _tag: "User" })
    }),
  )

  it.effect("rejects authored lifecycle combinations instead of coercing them to completed", () =>
    Effect.gen(function* () {
      const scenario = yield* loadAtomicWebhookReplayScenario
      const thread = scenario.threads[0]?.thread
      expect(thread).toBeDefined()
      if (thread === undefined) return

      expect(
        validateDemoReviewMessage({
          id: "invalid-user-message",
          sequence: 4,
          bodyMarkdown: "Still waiting",
          author: "user",
          status: "pending",
          agentRunId: "run-that-user-must-not-own",
          createdAt: "2026-07-10T08:19:00Z",
          updatedAt: "2026-07-10T08:19:00Z",
        }),
      ).toMatch(/must be complete/u)
    }),
  )

  it.effect("materializes tagged lifecycle states and rejects inconsistent authored fields", () =>
    Effect.gen(function* () {
      const scenario = yield* loadAtomicWebhookReplayScenario
      const firstWalkthrough = yield* decodeDemoJson(
        scenario.manifest.id,
        "initial-walkthrough.json",
        DemoWalkthroughSource,
        initialWalkthrough,
      )
      const secondWalkthrough = yield* decodeDemoJson(
        scenario.manifest.id,
        "database-clock-walkthrough.json",
        DemoWalkthroughSource,
        databaseClockWalkthrough,
      )
      const sourceThread = scenario.manifest.threads[0]
      expect(sourceThread).toBeDefined()
      if (sourceThread === undefined) return
      const authoredStates = [
        DemoThreadMessageSource.make({
          id: "message-pending",
          sequence: 4,
          author: "agent",
          bodyMarkdown: "",
          status: "pending",
          agentRunId: "run-pending",
          createdAt: "2026-07-10T08:19:00Z",
          updatedAt: "2026-07-10T08:19:00Z",
        }),
        DemoThreadMessageSource.make({
          id: "message-failed",
          sequence: 5,
          author: "agent",
          bodyMarkdown: "Provider process exited before producing a response.",
          status: "failed",
          agentRunId: "run-failed",
          createdAt: "2026-07-10T08:20:00Z",
          updatedAt: "2026-07-10T08:20:05Z",
        }),
        DemoThreadMessageSource.make({
          id: "message-user",
          sequence: 6,
          author: "user",
          bodyMarkdown: "Retry with the restored workspace.",
          status: "complete",
          agentRunId: null,
          createdAt: "2026-07-10T08:21:00Z",
          updatedAt: "2026-07-10T08:21:00Z",
        }),
      ]
      const manifest = DemoScenarioManifest.make({
        ...scenario.manifest,
        threads: [
          DemoThreadSource.make({
            ...sourceThread,
            messages: [...sourceThread.messages, ...authoredStates],
          }),
        ],
      })
      const assets = {
        diffs: {
          "revisions/01-initial/unified.diff": initialDiff,
          "revisions/02-database-clock/unified.diff": databaseClockDiff,
        },
        walkthroughs: {
          "revisions/01-initial/walkthrough.json": firstWalkthrough,
          "revisions/02-database-clock/walkthrough.json": secondWalkthrough,
        },
      }

      const materialized = yield* materializeDemoScenario(manifest, assets)
      expect(
        materialized.threads[0]?.conversation.slice(-3).map((turn) => Reflect.get(turn, "_tag")),
      ).toEqual(["Pending", "Failed", "User"])

      const manifestThread = manifest.threads[0]
      expect(manifestThread).toBeDefined()
      if (manifestThread === undefined) return
      const invalidManifest = DemoScenarioManifest.make({
        ...manifest,
        threads: [
          DemoThreadSource.make({
            ...manifestThread,
            messages: manifestThread.messages.map((message) =>
              message.id === "message-user"
                ? DemoThreadMessageSource.make({
                    ...message,
                    status: "pending",
                    agentRunId: "invalid-user-run",
                  })
                : message,
            ),
          }),
        ],
      })
      const error = yield* Effect.flip(materializeDemoScenario(invalidManifest, assets))
      expect(error.details).toContain(
        "User message message-user must be complete and must not reference an agent run.",
      )
    }),
  )
})
