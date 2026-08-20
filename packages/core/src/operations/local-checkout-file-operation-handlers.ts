import {
  LocalCheckoutFileListRejected,
  LocalCheckoutFileReadRejected,
} from "@diffdash/domain/local-checkout-file"
import { RepositoryCheckout } from "@diffdash/domain/repository"
import { LocalCheckoutFiles } from "@diffdash/local-git/local-checkout-files"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import { Effect } from "effect"

import { CoreMethod } from "../core-contract"
import type { OperationHandlersFor } from "./operation-handlers"

type LocalCheckoutFileMethod =
  | typeof CoreMethod.listLocalCheckoutFiles
  | typeof CoreMethod.readLocalCheckoutFile

/** Acquires checkout source listing and reading handlers keyed by durable project identity. */
export const makeLocalCheckoutFileOperationHandlers: Effect.Effect<
  OperationHandlersFor<LocalCheckoutFileMethod>,
  never,
  LocalCheckoutFiles | RepositoryStore
> = Effect.gen(function* () {
  const checkoutFiles = yield* LocalCheckoutFiles
  const repositories = yield* RepositoryStore

  return {
    [CoreMethod.listLocalCheckoutFiles]: ({ projectId }) =>
      repositories.getById(projectId).pipe(
        Effect.flatMap((repo) =>
          RepositoryCheckout.match(repo.checkout, {
            RemoteOnly: () =>
              Effect.succeed(LocalCheckoutFileListRejected.make({ reason: "checkoutUnavailable" })),
            LinkedCheckout: ({ path }) => checkoutFiles.list(path),
          }),
        ),
        Effect.catch((error) =>
          Effect.succeed(
            LocalCheckoutFileListRejected.make({
              reason:
                error.operation === "getById.notFound"
                  ? "repositoryNotFound"
                  : "repositoryUnavailable",
            }),
          ),
        ),
      ),
    [CoreMethod.readLocalCheckoutFile]: ({ projectId, path }) =>
      repositories.getById(projectId).pipe(
        Effect.flatMap((repo) =>
          RepositoryCheckout.match(repo.checkout, {
            RemoteOnly: () =>
              Effect.succeed(
                LocalCheckoutFileReadRejected.make({ path, reason: "checkoutUnavailable" }),
              ),
            LinkedCheckout: ({ path: localPath }) => checkoutFiles.read(localPath, path),
          }),
        ),
        Effect.catch((error) =>
          Effect.succeed(
            LocalCheckoutFileReadRejected.make({
              path,
              reason:
                error.operation === "getById.notFound"
                  ? "repositoryNotFound"
                  : "repositoryUnavailable",
            }),
          ),
        ),
      ),
  } satisfies OperationHandlersFor<LocalCheckoutFileMethod>
})
