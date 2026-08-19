import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ApplicationInstanceId, CoreProcessEpoch } from "@diffdash/core-rpc"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { ProcessService } from "@diffdash/process"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Option, Stream } from "effect"

import { CoreEventHub, makeCoreEventHubLayer } from "./core-event-hub"
import { CoreRepositoryWatcher, coreRepositoryWatcherLayer } from "./core-repository-watcher"

const makeTempDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "diffdash-core-watcher-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
)

const eventLayer = makeCoreEventHubLayer({
  applicationInstanceId: ApplicationInstanceId.make("watcher-app"),
  processEpoch: CoreProcessEpoch.make("watcher-epoch"),
})

const layer = coreRepositoryWatcherLayer.pipe(
  Layer.provideMerge(eventLayer),
  Layer.provide(ProcessService.layer),
)

describe("CoreRepositoryWatcher", () => {
  it.live("publishes generation-safe invalidation after a real native Git hint", () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectory
      git(directory, "init", "-b", "main")
      writeFileSync(join(directory, "README.md"), "initial\n")
      commitAll(directory, "initial")

      const events = yield* CoreEventHub
      const watcher = yield* CoreRepositoryWatcher
      const projectId = ReviewProjectId.make("project:real-watcher")
      const first = yield* nextEvent(events).pipe(Effect.forkChild)
      const generation = yield* watcher.activate(projectId, RepositoryCheckoutPath.make(directory))
      const initial = yield* Fiber.join(first)

      const changed = yield* nextEvent(events).pipe(Effect.forkChild)
      writeFileSync(join(directory, "README.md"), "changed\n")
      const invalidation = yield* Fiber.join(changed)

      expect(initial.metadata.subject).toMatchObject({
        kind: "generation",
        generationId: String(generation),
      })
      expect(invalidation).toMatchObject({
        kind: "stateChanged",
        stateVersion: initial.stateVersion + 1,
        metadata: {
          topic: "repository.state.changed",
          scopes: [{ name: "project", id: projectId }],
          subject: { kind: "generation", generationId: String(generation) },
        },
      })
    }).pipe(Effect.provide(layer)),
  )
})

const nextEvent = (events: CoreEventHub["Service"]) =>
  events.events.pipe(
    Stream.runHead,
    Effect.timeout("10 seconds"),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(new Error("Core event stream ended before invalidation")),
        onSome: Effect.succeed,
      }),
    ),
  )

const git = (cwd: string, ...args: readonly string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

const commitAll = (cwd: string, message: string): void => {
  git(cwd, "add", "-A")
  git(
    cwd,
    "-c",
    "user.name=DiffDash Test",
    "-c",
    "user.email=test@diffdash.dev",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    message,
  )
}
