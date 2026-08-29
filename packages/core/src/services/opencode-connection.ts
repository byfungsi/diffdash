import { delimiter, join } from "node:path"

import {
  CommentSubject,
  OpenCodeConnection,
  type OpenCodeSessionId,
  OpenCodeSessionSummary,
} from "@diffdash/domain/comment"
import { type CommentNote, formatCommentNotes } from "@diffdash/domain/comment-note"
import type { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import type {
  MarkdownBody,
  ReviewThreadAnchor,
  ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import { RepositoryStore } from "@diffdash/persistence/repository-store"
import type {
  ConnectOpenCodeSessionRequest,
  ListOpenCodeSessionsRequest,
} from "@diffdash/protocol/ai-connection"
import { type ProcessRunner, ProcessService, processRequest } from "@diffdash/process"
import { findExecutableInPath } from "@diffdash/process/executable"
import { Context, Effect, Layer, Option, Schema } from "effect"

const OpenCodeOperation = Schema.Literals([
  "connect",
  "forwardComment",
  "forwardNotes",
  "listSessions",
])
/** OpenCode API operation classified by the connection adapter. */
export type OpenCodeOperation = typeof OpenCodeOperation.Type

/** Recoverable failure while communicating with the user's OpenCode V2 service. */
export class OpenCodeConnectionError extends Schema.TaggedError<OpenCodeConnectionError>()(
  "OpenCodeConnectionError",
  {
    operation: OpenCodeOperation,
    code: Schema.String,
    safeMessage: Schema.String,
    cause: Schema.ErrorInstance(),
  },
) {}

/** Schema-backed GET or POST invocation accepted by the OpenCode command seam. */
export const OpenCodeApiRequest = Schema.TaggedUnion({
  Get: { operation: OpenCodeOperation, path: Schema.String },
  Post: { operation: OpenCodeOperation, path: Schema.String, body: Schema.String },
})
type OpenCodeApiRequest = typeof OpenCodeApiRequest.Type

/** Typed command seam for deterministic OpenCode V2 API adapter tests. */
export interface OpenCodeApiCommand {
  readonly run: (request: OpenCodeApiRequest) => Effect.Effect<string, OpenCodeConnectionError>
}

/** Runtime configuration used to discover the authenticated OpenCode command. */
export interface OpenCodeConnectionOptions {
  readonly executableSearchPath: string
  readonly executablePathExtensions: Option.Option<string>
  readonly homeDirectory: Option.Option<string>
  readonly platform: NodeJS.Platform
}

/** Authorized project and comment input accepted by Core-owned OpenCode forwarding. */
export interface ForwardOpenCodeCommentInput {
  readonly projectId: ReviewProjectId
  readonly sessionId: OpenCodeSessionId
  readonly subject: typeof CommentSubject.Type
  readonly body: MarkdownBody
}

/** Authorized ordered note snapshot accepted by Core-owned OpenCode forwarding. */
export interface ForwardOpenCodeNotesInput {
  readonly projectId: ReviewProjectId
  readonly sessionId: OpenCodeSessionId
  readonly notes: readonly CommentNote[]
}

/** Core-owned OpenCode session discovery, connection, and forwarding capability. */
export interface OpenCodeConnectionOperations {
  readonly listSessions: (
    request: ListOpenCodeSessionsRequest,
  ) => Effect.Effect<readonly OpenCodeSessionSummary[], OpenCodeConnectionError>
  readonly connect: (
    request: ConnectOpenCodeSessionRequest,
  ) => Effect.Effect<OpenCodeConnection, OpenCodeConnectionError>
  readonly forwardComment: (
    request: ForwardOpenCodeCommentInput,
  ) => Effect.Effect<void, OpenCodeConnectionError>
  readonly forwardNotes: (
    request: ForwardOpenCodeNotesInput,
  ) => Effect.Effect<void, OpenCodeConnectionError>
}

const RawSessionsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: OpenCodeSessionSummary.fields.id,
      title: Schema.optionalKey(Schema.String),
      time: Schema.Struct({ updated: Schema.Number }),
      location: Schema.Struct({ directory: OpenCodeSessionSummary.fields.directory }),
    }),
  ),
})
const RawSessionResponse = Schema.Struct({
  data: Schema.Struct({
    id: OpenCodeSessionSummary.fields.id,
    location: Schema.Struct({ directory: OpenCodeSessionSummary.fields.directory }),
  }),
})
const RawPlanAgentResponse = Schema.Union([
  Schema.Struct({
    data: Schema.Struct({
      id: Schema.Literal("plan"),
      mode: Schema.Literals(["primary", "all", "subagent"]),
      hidden: Schema.Boolean,
    }),
  }),
  Schema.Struct({ _tag: Schema.Literal("AgentNotFoundError") }),
])
const RawPromptResponse = Schema.Struct({
  data: Schema.Struct({
    id: Schema.String.pipe(Schema.check(Schema.isPattern(/^msg_/u))),
    sessionID: OpenCodeSessionSummary.fields.id,
    type: Schema.Literal("user"),
    payload: Schema.Struct({ text: Schema.String }),
    delivery: Schema.Literals(["steer", "queue"]),
    timeCreated: Schema.Number,
  }),
})
const AgentSwitchBody = Schema.Struct({ agent: Schema.Literal("plan") })
const PromptBody = Schema.Struct({ text: Schema.String })
const parseSessions = Schema.decodeUnknownEffect(Schema.fromJsonString(RawSessionsResponse))
const parseSession = Schema.decodeUnknownEffect(Schema.fromJsonString(RawSessionResponse))
const parsePlanAgent = Schema.decodeUnknownEffect(Schema.fromJsonString(RawPlanAgentResponse))
const parsePrompt = Schema.decodeUnknownEffect(Schema.fromJsonString(RawPromptResponse))
const encodeAgentSwitch = Schema.encodeSync(Schema.fromJsonString(AgentSwitchBody))
const encodePrompt = Schema.encodeSync(Schema.fromJsonString(PromptBody))

const failure = (
  operation: OpenCodeOperation,
  safeMessage: string,
  cause: Error,
): OpenCodeConnectionError =>
  OpenCodeConnectionError.make({
    operation,
    code: "OPENCODE_CONNECTION_FAILED",
    safeMessage,
    cause,
  })

const decodeResponse = <A, R>(
  operation: OpenCodeOperation,
  safeMessage: string,
  decode: (input: string) => Effect.Effect<A, Error, R>,
  input: string,
) => decode(input).pipe(Effect.mapError((cause) => failure(operation, safeMessage, cause)))

const MAX_PROMPT_CHARACTERS = 60 * 1_024
const MAX_CONTEXT_VALUE_CHARACTERS = 12 * 1_024

const boundText = (value: string, maximum: number): string => {
  if (value.length <= maximum) return value
  const marker = "\n[Content truncated by DiffDash]"
  if (maximum <= marker.length) return value.slice(0, maximum)
  return `${value.slice(0, Math.max(0, maximum - marker.length))}${marker}`
}

const boundedJson = (value: ReviewThreadTarget | ReviewThreadAnchor): string =>
  boundText(JSON.stringify(value, null, 2), MAX_CONTEXT_VALUE_CHARACTERS)

const formatCommentForAgent = (subject: typeof CommentSubject.Type, body: MarkdownBody): string => {
  const context = CommentSubject.match(subject, {
    ReviewLine: ({ target, expectedBaseRevision, expectedHeadRevision, anchor }) =>
      [
        "Source: DiffDash review line",
        `Base revision: ${boundText(expectedBaseRevision, MAX_CONTEXT_VALUE_CHARACTERS)}`,
        `Head revision: ${boundText(expectedHeadRevision, MAX_CONTEXT_VALUE_CHARACTERS)}`,
        "Review target:",
        boundedJson(target),
        "Current line anchor:",
        boundedJson(anchor),
      ].join("\n"),
    CodeLine: ({ projectId, revision, path, lineNumber, lineContent }) =>
      [
        "Source: DiffDash code line",
        `Project: ${boundText(projectId, MAX_CONTEXT_VALUE_CHARACTERS)}`,
        `Revision: ${boundText(revision, MAX_CONTEXT_VALUE_CHARACTERS)}`,
        `Path: ${boundText(path, MAX_CONTEXT_VALUE_CHARACTERS)}`,
        `Line: ${String(lineNumber)}`,
        "Line content:",
        boundText(lineContent, MAX_CONTEXT_VALUE_CHARACTERS),
      ].join("\n"),
  })
  const prefix = `${context}\n\nUser comment:\n`
  return `${prefix}${boundText(body, Math.max(0, MAX_PROMPT_CHARACTERS - prefix.length))}`
}

const makeLiveCommand = (
  processes: ProcessRunner,
  options: OpenCodeConnectionOptions,
): OpenCodeApiCommand => ({
  run: (request) => {
    const operation = OpenCodeApiRequest.match(request, {
      Get: ({ operation: requestOperation }) => requestOperation,
      Post: ({ operation: requestOperation }) => requestOperation,
    })
    const executableSearchPath = Option.match(options.homeDirectory, {
      onNone: () => options.executableSearchPath,
      onSome: (home) =>
        [join(home, ".opencode", "bin"), options.executableSearchPath].join(delimiter),
    })
    const executableOptions = Option.match(options.executablePathExtensions, {
      onNone: () => ({ envPath: executableSearchPath, platform: options.platform }),
      onSome: (pathExt) => ({ envPath: executableSearchPath, pathExt, platform: options.platform }),
    })
    return findExecutableInPath("opencode2", executableOptions).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              failure(
                operation,
                "OpenCode V2 is not installed or is unavailable from DiffDash.",
                new Error("opencode2 executable not found"),
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.flatMap((executable) => {
        const args = OpenCodeApiRequest.match(request, {
          Get: ({ path }) => ["api", "get", path],
          Post: ({ path, body }) => ["api", "post", path, "--data", body],
        })
        return processes
          .run(
            processRequest(executable, args, {
              timeoutMs: 15_000,
              stdout: { maxBytes: 256 * 1_024, overflow: "error" },
              stderr: { maxBytes: 32 * 1_024, overflow: "truncate" },
            }),
          )
          .pipe(Effect.map((result) => result.stdout.trim()))
          .pipe(
            Effect.mapError((cause) =>
              failure(operation, "DiffDash could not communicate with OpenCode V2.", cause),
            ),
          )
      }),
    )
  },
})

/** Creates the OpenCode connection implementation over typed API and repository authorities. */
export const makeOpenCodeConnectionService = (
  command: OpenCodeApiCommand,
  repositories: Pick<RepositoryStore["Service"], "getById">,
): OpenCodeConnectionOperations => {
  const connections = new Map<
    OpenCodeSessionId,
    { readonly projectId: ReviewProjectId; readonly directory: RepositoryCheckoutPath }
  >()
  const resolveCheckout = Effect.fn("OpenCodeConnection.resolveCheckout")(function* (
    projectId: ReviewProjectId,
    operation: OpenCodeOperation,
  ) {
    const repository = yield* repositories
      .getById(projectId)
      .pipe(
        Effect.mapError((cause) =>
          failure(operation, "DiffDash could not authorize this OpenCode project.", cause),
        ),
      )
    if (repository.localPath === null) {
      return yield* Effect.fail(
        failure(
          operation,
          "Link a local checkout before connecting OpenCode.",
          new Error(`Project has no linked checkout: ${projectId}`),
        ),
      )
    }
    return repository.localPath
  })
  const forwardPrompt = Effect.fn("OpenCodeConnection.forwardPrompt")(function* (
    projectId: ReviewProjectId,
    sessionId: OpenCodeSessionId,
    operation: "forwardComment" | "forwardNotes",
    text: string,
  ) {
    if (operation === "forwardNotes" && text.length > MAX_PROMPT_CHARACTERS) {
      return yield* Effect.fail(
        failure(
          operation,
          "The collected notes are too large to send in one OpenCode prompt. Remove or copy some notes, then retry.",
          new Error("The collected note prompt exceeds the OpenCode prompt limit"),
        ),
      )
    }
    const connection = connections.get(sessionId)
    if (connection === undefined || connection.projectId !== projectId) {
      return yield* Effect.fail(
        failure(
          operation,
          "Reconnect this OpenCode session before forwarding comments.",
          new Error("The selected OpenCode session is not authorized for this project"),
        ),
      )
    }
    const directory = yield* resolveCheckout(projectId, operation)
    if (directory !== connection.directory) {
      connections.delete(sessionId)
      return yield* Effect.fail(
        failure(
          operation,
          "Reconnect this OpenCode session after changing the linked checkout.",
          new Error("The authorized project checkout changed after OpenCode connection"),
        ),
      )
    }
    const output = yield* command.run(
      OpenCodeApiRequest.cases.Post.make({
        operation,
        path: `/api/session/${sessionId}/prompt`,
        body: encodePrompt({
          text: operation === "forwardNotes" ? text : boundText(text, MAX_PROMPT_CHARACTERS),
        }),
      }),
    )
    const response = yield* decodeResponse(
      operation,
      operation === "forwardNotes"
        ? "OpenCode did not accept these notes."
        : "OpenCode did not accept this comment.",
      parsePrompt,
      output,
    )
    if (response.data.sessionID !== sessionId) {
      return yield* Effect.fail(
        failure(
          operation,
          "OpenCode accepted the comment for an unexpected session.",
          new Error(`Expected ${sessionId}, received ${response.data.sessionID}`),
        ),
      )
    }
    return yield* Effect.void
  })

  return {
    listSessions: Effect.fn("OpenCodeConnection.listSessions")(function* (
      request: ListOpenCodeSessionsRequest,
    ) {
      const directory = yield* resolveCheckout(request.projectId, "listSessions")
      const query = new URLSearchParams({
        directory,
        limit: "5",
        order: "desc",
        parentID: "null",
      })
      if (request.search !== null) query.set("search", request.search)
      const output = yield* command.run(
        OpenCodeApiRequest.cases.Get.make({
          operation: "listSessions",
          path: `/api/session?${query.toString()}`,
        }),
      )
      const response = yield* decodeResponse(
        "listSessions",
        "OpenCode returned an invalid session list.",
        parseSessions,
        output,
      )
      return response.data
        .filter((session) => session.location.directory === directory)
        .slice(0, 5)
        .map((session) =>
          OpenCodeSessionSummary.make({
            id: session.id,
            title: Option.match(Option.fromNullishOr(session.title), {
              onNone: () => "Untitled session",
              onSome: (title) => title.trim() || "Untitled session",
            }),
            directory: session.location.directory,
            updatedAt: session.time.updated,
          }),
        )
    }),
    connect: Effect.fn("OpenCodeConnection.connect")(function* (
      request: ConnectOpenCodeSessionRequest,
    ) {
      const directory = yield* resolveCheckout(request.projectId, "connect")
      const location = new URLSearchParams({ "location[directory]": directory })
      const sessionOutput = yield* command.run(
        OpenCodeApiRequest.cases.Get.make({
          operation: "connect",
          path: `/api/session/${request.sessionId}?${location.toString()}`,
        }),
      )
      const session = yield* decodeResponse(
        "connect",
        "OpenCode could not find this session.",
        parseSession,
        sessionOutput,
      )
      if (session.data.id !== request.sessionId) {
        return yield* Effect.fail(
          failure(
            "connect",
            "OpenCode returned an unexpected session.",
            new Error(`Expected ${request.sessionId}, received ${session.data.id}`),
          ),
        )
      }
      if (session.data.location.directory !== directory) {
        return yield* Effect.fail(
          failure(
            "connect",
            "This OpenCode session belongs to a different project checkout.",
            new Error(
              `Expected session directory ${directory}, received ${session.data.location.directory}`,
            ),
          ),
        )
      }
      const output = yield* command.run(
        OpenCodeApiRequest.cases.Get.make({
          operation: "connect",
          path: `/api/agent/plan?${location.toString()}`,
        }),
      )
      const agent = yield* decodeResponse(
        "connect",
        "OpenCode returned an invalid plan-agent response.",
        parsePlanAgent,
        output,
      )
      const planMode = "data" in agent && agent.data.mode !== "subagent" && !agent.data.hidden
      if (!planMode) {
        connections.set(request.sessionId, { projectId: request.projectId, directory })
        return OpenCodeConnection.make({ sessionId: request.sessionId, planMode })
      }
      const switchOutput = yield* command.run(
        OpenCodeApiRequest.cases.Post.make({
          operation: "connect",
          path: `/api/session/${request.sessionId}/agent`,
          body: encodeAgentSwitch({ agent: "plan" }),
        }),
      )
      if (switchOutput.length > 0) {
        return yield* Effect.fail(
          failure(
            "connect",
            "OpenCode could not switch this session to the plan agent.",
            new Error(switchOutput),
          ),
        )
      }
      connections.set(request.sessionId, { projectId: request.projectId, directory })
      return OpenCodeConnection.make({ sessionId: request.sessionId, planMode })
    }),
    forwardComment: Effect.fn("OpenCodeConnection.forwardComment")(function* (
      request: ForwardOpenCodeCommentInput,
    ) {
      if (
        CommentSubject.guards.CodeLine(request.subject) &&
        request.subject.projectId !== request.projectId
      ) {
        return yield* Effect.fail(
          failure(
            "forwardComment",
            "The selected OpenCode session belongs to a different project.",
            new Error("The code-line subject project does not match the authorized connection"),
          ),
        )
      }
      return yield* forwardPrompt(
        request.projectId,
        request.sessionId,
        "forwardComment",
        formatCommentForAgent(request.subject, request.body),
      )
    }),
    forwardNotes: Effect.fn("OpenCodeConnection.forwardNotes")(function* (
      request: ForwardOpenCodeNotesInput,
    ) {
      yield* forwardPrompt(
        request.projectId,
        request.sessionId,
        "forwardNotes",
        formatCommentNotes(request.notes),
      )
    }),
  }
}

/** Core-owned OpenCode V2 connection and prompting authority. */
export class OpenCodeConnectionService extends Context.Service<
  OpenCodeConnectionService,
  OpenCodeConnectionOperations
>()("@diffdash/core/OpenCodeConnectionService") {
  static layer = (options: OpenCodeConnectionOptions) =>
    Layer.effect(
      OpenCodeConnectionService,
      Effect.gen(function* () {
        const processes = yield* ProcessService
        const repositories = yield* RepositoryStore
        return OpenCodeConnectionService.of(
          makeOpenCodeConnectionService(makeLiveCommand(processes, options), repositories),
        )
      }),
    )
}
