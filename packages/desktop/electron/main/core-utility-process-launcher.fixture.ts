import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import {
  ApplicationInstanceId,
  DatabaseOwnershipAuthorizationId,
  HostRequestContext,
  HostRequestId,
} from "@diffdash/core-rpc/identity"
import { AuthorizeDatabaseOwnershipRequest } from "@diffdash/core-rpc/lifecycle"
import { CodeWorkspaceLease, ProjectHeadCodeWorkspaceTarget } from "@diffdash/domain/code-workspace"
import { LanguagePosition } from "@diffdash/domain/language"
import { ProjectOpenResult } from "@diffdash/domain/project-workspace"
import { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { TempResources } from "@diffdash/process/temp-resource"
import { Effect, Layer, Option, Schema } from "effect"
import { app } from "electron"

import { verifyCoreArtifact } from "./core-artifact"
import { bootstrapCoreHost } from "./core-host-bootstrap"
import { startCoreUtilityProcess } from "./core-utility-process-launcher"
import { makeCoreProcessFixtureConfiguration } from "./core-process-configuration.fixture"

const ProbeArguments = Schema.Tuple([
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
])
const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const dependencies = Layer.merge(
  TempResources.layer.pipe(Layer.provide(platformLayer)),
  platformLayer,
)

const probe = Effect.gen(function* () {
  const [artifactDirectory, temporaryDirectory, statePath, expectedBuildId, repositoryDirectory] =
    yield* Schema.decodeUnknownEffect(ProbeArguments)(process.argv.slice(-5)).pipe(Effect.orDie)
  const artifact = yield* verifyCoreArtifact({ artifactDirectory, expectedBuildId })
  const session = yield* bootstrapCoreHost({
    artifact,
    applicationInstanceId: ApplicationInstanceId.make("app-electron-utility-probe"),
    temporaryDirectory,
    startTransport: (configuration) =>
      startCoreUtilityProcess({
        configuration,
        databasePath: `${statePath}.sqlite`,
        statePath,
        coreConfiguration: makeCoreProcessFixtureConfiguration(`${statePath}.sqlite`, statePath),
      }),
  })
  yield* session.authorizeDatabaseOwnership(
    AuthorizeDatabaseOwnershipRequest.make({
      applicationInstanceId: session.applicationInstanceId,
      processEpoch: session.processEpoch,
      requestId: HostRequestId.make("h:utility-ownership"),
      authorizationId: DatabaseOwnershipAuthorizationId.make("ownership-electron-utility-probe"),
    }),
  )
  const client = yield* Effect.fromOption(Option.fromNullishOr(session.client)).pipe(Effect.orDie)
  let requestSequence = 0
  const requestContext = () => {
    requestSequence += 1
    return HostRequestContext.make({
      applicationInstanceId: session.applicationInstanceId,
      processEpoch: session.processEpoch,
      requestId: HostRequestId.make(`h:utility-${String(requestSequence)}`),
    })
  }
  const lifecycle = yield* client.health(requestContext()).pipe(
    Effect.delay("10 millis"),
    Effect.map((health) => health.lifecycle),
    Effect.repeat({ until: (state) => state === "ready", times: 999 }),
  )
  yield* Effect.succeed(lifecycle).pipe(
    Effect.filterOrFail(
      (state) => state === "ready",
      () => new Error("Core did not become ready."),
    ),
    Effect.orDie,
  )

  const opened = yield* client.openProject({
    ...requestContext(),
    localPath: RepositoryCheckoutPath.make(repositoryDirectory),
    selectedRepository: null,
  })
  const repository = yield* ProjectOpenResult.match(opened, {
    opened: ({ repo }) => Effect.succeed(repo),
    remoteSelectionRequired: () =>
      Effect.die(new Error("Local fixture unexpectedly required remote selection.")),
  })
  const lease = yield* client.openCodeWorkspace({
    ...requestContext(),
    target: ProjectHeadCodeWorkspaceTarget.make({ projectId: repository.id }),
  })
  const encodedLease = Schema.encodeUnknownSync(CodeWorkspaceLease)(lease)
  yield* Effect.fromOption(
    lease.gitRevision,
    () => new Error("Core RPC did not decode the workspace Git revision into main-owned Option."),
  ).pipe(Effect.orDie)
  yield* Effect.succeed(encodedLease).pipe(
    Effect.filterOrFail(
      ({ gitRevision }) => gitRevision !== null,
      () => new Error("Core RPC did not encode the workspace Git revision onto its wire schema."),
    ),
    Effect.orDie,
  )
  const definitions = yield* client.codeWorkspaceDefinitions({
    ...requestContext(),
    leaseId: lease.id,
    path: RepositoryRelativePath.make("source.ts"),
    position: new LanguagePosition({ line: 1, character: 1 }),
  })
  const references = yield* client.codeWorkspaceReferences({
    ...requestContext(),
    leaseId: lease.id,
    path: RepositoryRelativePath.make("source.ts"),
    position: new LanguagePosition({ line: 1, character: 1 }),
  })
  yield* client.releaseCodeWorkspace({ ...requestContext(), leaseId: lease.id })
  const targetPath = yield* Effect.fromOption(
    Option.fromNullishOr(definitions.locations[0]?.target.path),
  ).pipe(Effect.orDie)
  yield* Effect.succeed(targetPath).pipe(
    Effect.filterOrFail(
      (path) => path === "target.ts",
      () => new Error("Packaged TypeScript definitions did not resolve."),
    ),
    Effect.orDie,
  )
  yield* Effect.succeed(references.locations).pipe(
    Effect.filterOrFail(
      (locations) => locations.some((location) => location.target.path === "source.ts"),
      () => new Error("Packaged TypeScript references did not resolve."),
    ),
    Effect.orDie,
  )
  console.info(`DIFFDASH_CORE_UTILITY_PROBE_READY:${targetPath}`)
  return undefined
}).pipe(Effect.provide(dependencies), Effect.scoped)

void app
  .whenReady()
  .then(() => Effect.runPromise(probe))
  .then(
    () => app.exit(0),
    () => {
      console.error("DIFFDASH_CORE_UTILITY_PROBE_FAILED")
      app.exit(1)
    },
  )
