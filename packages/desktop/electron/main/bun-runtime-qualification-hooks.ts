import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { CoreAbsolutePath, CoreConfiguration, ProcessArchitecture } from "@diffdash/core"
import { ApplicationInstanceId } from "@diffdash/core-rpc/identity"
import { TempResources } from "@diffdash/process/temp-resource"
import { Effect, Layer, Schema } from "effect"
import { spawn } from "node:child_process"
import { join } from "node:path"

import { bootstrapCoreHost } from "./core-host-bootstrap"
import {
  BunRuntimeProbeError,
  type BunRuntimeCandidate,
  type BunRuntimeFacts,
  type BunRuntimeQualificationHooks,
  startCoreBunProcess,
} from "./core-bun-runtime"
import type { VerifiedCoreArtifact } from "./core-artifact"

const PROCESS_TIMEOUT_MILLISECONDS = 3_000
const CORE_HEALTH_TIMEOUT_MILLISECONDS = 10_000
const PROCESS_OUTPUT_LIMIT_BYTES = 4_096
const SAFE_MESSAGE = "A Bun runtime probe failed." as const
const CORE_HEALTH_ATTEMPTS = 3
const scriptCapabilities = [
  "worker",
  "processCancellation",
  "filesystem",
  "socket",
  "sqlite",
] as const
type ScriptCapability = (typeof scriptCapabilities)[number]

const RuntimeFactsJson = Schema.fromJsonString(
  Schema.Struct({ version: Schema.String, architecture: ProcessArchitecture }),
)

const BUN_PROBE_SOURCE = String.raw`
const fail = () => { throw new Error("probe failed") }
const mode = process.argv.at(-1)

const runtimeFacts = () => {
  if (typeof Bun?.version !== "string" || Bun.version.length === 0) fail()
  process.stdout.write(JSON.stringify({ version: Bun.version, architecture: process.arch }))
}

const worker = async () => {
  const source = URL.createObjectURL(new Blob(["postMessage('ready')"], { type: "text/javascript" }))
  const instance = new Worker(source)
  try {
    const result = await new Promise((resolve, reject) => {
      instance.onmessage = (event) => resolve(event.data)
      instance.onerror = reject
    })
    if (result !== "ready") fail()
  } finally {
    instance.terminate()
    URL.revokeObjectURL(source)
  }
}

const processCancellation = async () => {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "--no-install", "-e", "setInterval(() => {}, 1000)"],
    { env: {}, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  )
  child.kill()
  const exitCode = await child.exited
  if (exitCode === 0) fail()
}

const filesystem = async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const directory = await mkdtemp(join(tmpdir(), "dd-bun-probe-"))
  try {
    const path = join(directory, "value")
    await writeFile(path, "ready", { mode: 0o600 })
    if ((await readFile(path, "utf8")) !== "ready") fail()
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

const socket = async () => {
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open(connection) { connection.write("ready"); connection.end() } },
  })
  try {
    const client = await Bun.connect({
      hostname: "127.0.0.1",
      port: listener.port,
      socket: {
        data(connection, bytes) {
          if (new TextDecoder().decode(bytes) === "ready") resolveReady()
          else rejectReady(new Error("probe failed"))
          connection.end()
        },
        error(_connection, error) { rejectReady(error) },
      },
    })
    await ready
    client.end()
  } finally {
    listener.stop(true)
  }
}

const sqlite = async () => {
  const { Database } = await import("bun:sqlite")
  const database = new Database(":memory:", { strict: true })
  try {
    database.run("CREATE TABLE probe (value TEXT NOT NULL) STRICT")
    database.run("INSERT INTO probe VALUES (?)", ["ready"])
    if (database.query("SELECT value FROM probe").get()?.value !== "ready") fail()
  } finally {
    database.close()
  }
}

const probes = { runtimeFacts, worker, processCancellation, filesystem, socket, sqlite }
const probe = probes[mode]
if (probe === undefined) fail()
await probe()
`

/** A bounded execution seam for testing qualification without an installed Bun executable. */
export interface BunRuntimeQualificationExecutor {
  readonly runtimeFacts: (
    candidate: BunRuntimeCandidate,
  ) => Effect.Effect<BunRuntimeFacts, BunRuntimeProbeError>
  readonly runScriptProbe: (
    candidate: BunRuntimeCandidate,
    capability: ScriptCapability,
  ) => Effect.Effect<void, BunRuntimeProbeError>
  readonly runCoreHealthProbe: (
    candidate: BunRuntimeCandidate,
  ) => Effect.Effect<void, BunRuntimeProbeError>
}

/** Production inputs captured by the external Bun qualification hooks. */
export interface BunRuntimeQualificationOptions {
  readonly applicationCwd: string
  readonly artifact: VerifiedCoreArtifact
  readonly coreConfiguration: CoreConfiguration
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly temporaryDirectory: string
}

const probeError = () => BunRuntimeProbeError.make({ safeMessage: SAFE_MESSAGE })

/** Bounds a Bun Core health exchange and retries with a fresh scoped process after a stall. */
export const retryBunCoreHealthProbe = <Error>(
  probe: Effect.Effect<void, Error>,
): Effect.Effect<void, Error | BunRuntimeProbeError> =>
  probe.pipe(
    Effect.timeoutOrElse({
      duration: CORE_HEALTH_TIMEOUT_MILLISECONDS,
      orElse: () => Effect.fail(probeError()),
    }),
    Effect.retry({ times: CORE_HEALTH_ATTEMPTS - 1 }),
  )

const probeEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
  const result: Record<string, string> = {}
  for (const name of [
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "USERPROFILE",
    "WINDIR",
  ]) {
    const value = environment[name]
    if (value !== undefined) result[name] = value
  }
  return result
}

const executeProbe = (
  executablePath: string,
  capability: "runtimeFacts" | ScriptCapability,
  options: BunRuntimeQualificationOptions,
): Effect.Effect<string, BunRuntimeProbeError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(
          executablePath,
          ["--no-env-file", "--no-install", "-e", BUN_PROBE_SOURCE, capability],
          {
            cwd: options.applicationCwd,
            env: probeEnvironment(options.environment),
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        )
        const chunks: Array<Buffer> = []
        let outputBytes = 0
        let settled = false
        const finish = (result: { readonly ok: true } | { readonly ok: false }): void => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          if (result.ok) resolve(Buffer.concat(chunks).toString("utf8"))
          else reject(probeError())
        }
        const timeout = setTimeout(() => {
          child.kill()
          finish({ ok: false })
        }, PROCESS_TIMEOUT_MILLISECONDS)
        child.stdout.on("data", (chunk: Buffer) => {
          outputBytes += chunk.byteLength
          if (outputBytes > PROCESS_OUTPUT_LIMIT_BYTES) {
            child.kill()
            finish({ ok: false })
            return
          }
          chunks.push(chunk)
        })
        child.stderr.on("data", (chunk: Buffer) => {
          outputBytes += chunk.byteLength
          if (outputBytes > PROCESS_OUTPUT_LIMIT_BYTES) {
            child.kill()
            finish({ ok: false })
          }
        })
        child.once("error", () => finish({ ok: false }))
        child.once("exit", (code) => finish(code === 0 ? { ok: true } : { ok: false }))
      }),
    catch: probeError,
  })

const platformLayer = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  TempResources.layer.pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
)

const makeSystemExecutor = (
  options: BunRuntimeQualificationOptions,
): BunRuntimeQualificationExecutor => {
  const completedHealthProbes = new Map<string, Promise<void>>()
  const runCoreHealth = (candidate: BunRuntimeCandidate): Promise<void> => {
    const existing = completedHealthProbes.get(candidate.executablePath)
    if (existing !== undefined) return existing
    const probe = Effect.runPromise(
      retryBunCoreHealthProbe(
        Effect.scoped(
          Effect.gen(function* () {
            const tempResources = yield* TempResources
            const directory = yield* tempResources.makeTempDirectoryScoped({
              parentDirectory: options.temporaryDirectory,
              prefix: "dd-bun-qualification-",
            })
            const databasePath = join(directory, "qualification.sqlite")
            const statePath = join(directory, "state.json")
            const encodedConfiguration = yield* Schema.encodeEffect(CoreConfiguration)(
              options.coreConfiguration,
            )
            const configuration = yield* Schema.decodeUnknownEffect(CoreConfiguration)({
              ...encodedConfiguration,
              paths: {
                ...encodedConfiguration.paths,
                database: CoreAbsolutePath.make(databasePath),
                settings: CoreAbsolutePath.make(join(directory, "settings.json")),
                state: CoreAbsolutePath.make(statePath),
                temporaryDirectory: CoreAbsolutePath.make(join(directory, "temp")),
                worktreePool: CoreAbsolutePath.make(join(directory, "worktrees")),
                remoteWorktreePool: CoreAbsolutePath.make(join(directory, "remote-worktrees")),
              },
            })
            yield* bootstrapCoreHost({
              artifact: options.artifact,
              applicationInstanceId: ApplicationInstanceId.make("bun-runtime-qualification"),
              temporaryDirectory: directory,
              startTransport: (transport) =>
                startCoreBunProcess({
                  applicationCwd: options.applicationCwd,
                  bunExecutablePath: candidate.executablePath,
                  configuration: transport,
                  databasePath,
                  environment: options.environment,
                  statePath,
                  coreConfiguration: configuration,
                  listenTimeout: CORE_HEALTH_TIMEOUT_MILLISECONDS,
                }).pipe(Effect.asVoid),
            })
          }),
        ).pipe(Effect.provide(platformLayer)),
      ),
    ).then(() => undefined)
    completedHealthProbes.set(candidate.executablePath, probe)
    return probe
  }

  return {
    runtimeFacts: (candidate) =>
      executeProbe(candidate.executablePath, "runtimeFacts", options).pipe(
        Effect.flatMap((output) =>
          Schema.decodeUnknownEffect(RuntimeFactsJson)(output).pipe(Effect.mapError(probeError)),
        ),
      ),
    runScriptProbe: (candidate, capability) =>
      executeProbe(candidate.executablePath, capability, options).pipe(Effect.asVoid),
    runCoreHealthProbe: (candidate) =>
      Effect.tryPromise({ try: () => runCoreHealth(candidate), catch: probeError }),
  }
}

/** Creates concrete GUI-safe qualification hooks for Core host selection. */
export const makeBunRuntimeQualificationHooks = (
  options: BunRuntimeQualificationOptions,
  executor: BunRuntimeQualificationExecutor = makeSystemExecutor(options),
): BunRuntimeQualificationHooks => ({
  runtimeFacts: executor.runtimeFacts,
  worker: (candidate) => executor.runScriptProbe(candidate, "worker"),
  processCancellation: (candidate) => executor.runScriptProbe(candidate, "processCancellation"),
  filesystem: (candidate) => executor.runScriptProbe(candidate, "filesystem"),
  socket: (candidate) => executor.runScriptProbe(candidate, "socket"),
  sqlite: (candidate) => executor.runScriptProbe(candidate, "sqlite"),
  effect: executor.runCoreHealthProbe,
  artifact: executor.runCoreHealthProbe,
  coreHealth: executor.runCoreHealthProbe,
})
