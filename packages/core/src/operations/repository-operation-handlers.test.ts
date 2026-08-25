import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { GitService } from "@diffdash/local-git/local-git"
import { ProjectWorkspaceStore } from "@diffdash/persistence/project-workspace-store"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"

import { CoreMethod } from "../core-contract"
import { CoreRepositoryWatcher } from "../core-repository-watcher"
import { GitProvider } from "../services/git-provider"
import { RepositoryLinker } from "../services/repository-linker"
import { makeRepositoryOperationHandlers } from "./repository-operation-handlers"

const projectId = ReviewProjectId.make("github:fungsi/diffdash")

const layer = Layer.mergeAll(
  Layer.mock(CoreRepositoryWatcher, {}),
  Layer.mock(GitProvider, {}),
  Layer.mock(GitService, {}),
  Layer.mock(ProjectWorkspaceStore, { get: () => Effect.succeed(Option.none()) }),
  Layer.mock(RepositoryLinker, {}),
)

describe("repository operation handlers", () => {
  it.effect("keeps missing project workspace state as Option inside Core", () =>
    Effect.gen(function* () {
      const handlers = yield* makeRepositoryOperationHandlers

      expect(yield* handlers[CoreMethod.projectWorkspaceGet]({ projectId }, {})).toEqual(
        Option.none(),
      )
    }).pipe(Effect.provide(layer)),
  )
})
