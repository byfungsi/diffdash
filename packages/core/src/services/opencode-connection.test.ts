import { CommentSubject, OpenCodeSessionId } from "@diffdash/domain/comment"
import { LocalRepositorySource } from "@diffdash/domain/git-provider"
import { workingTreeReviewTarget } from "@diffdash/domain/local-review"
import { GitCommitSha } from "@diffdash/domain/repository-comparison"
import { LinkedCheckout, Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  ReviewFileId,
  ReviewHunkFingerprint,
  ReviewHunkId,
  ReviewProjectId,
  ReviewRevision,
} from "@diffdash/domain/review-identity"
import { LineReviewAnchor, MarkdownBody } from "@diffdash/domain/review-thread"
import {
  ConnectOpenCodeSessionRequest,
  ListOpenCodeSessionsRequest,
} from "@diffdash/protocol/ai-connection"
import { Effect, Option, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"

import {
  type OpenCodeApiCommand,
  OpenCodeApiRequest,
  makeOpenCodeConnectionService,
} from "./opencode-connection"

const sessionId = OpenCodeSessionId.make("ses_example")
const directory = RepositoryCheckoutPath.make("/workspace")
const projectId = ReviewProjectId.make("project")
const sessionResponse = JSON.stringify({ data: { id: sessionId, location: { directory } } })
const unavailablePlan = JSON.stringify({ _tag: "AgentNotFoundError" })
const timestamp = "2026-08-22T00:00:00.000Z"
const repositoryAt = (path: RepositoryCheckoutPath, id = projectId) =>
  Repo.make({
    id,
    source: LocalRepositorySource.make(),
    checkout: LinkedCheckout.make({ remoteUrl: `file://${path}`, path }),
    isFavorite: false,
    lastOpenedAt: null,
    lastSyncedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
const repositories = { getById: () => Effect.succeed(repositoryAt(directory)) }

describe("OpenCodeConnectionService", () => {
  it("lists at most five searched root sessions newest first", async () => {
    const run = vi.fn<OpenCodeApiCommand["run"]>((request) =>
      Effect.succeed(
        OpenCodeApiRequest.match(request, {
          Post: () => "",
          Get: ({ path }) => {
            expect(path).toContain("limit=5")
            expect(path).toContain("order=desc")
            expect(path).toContain("parentID=null")
            expect(path).toContain("search=review")
            return JSON.stringify({
              data: Array.from({ length: 6 }, (_, index) => ({
                id: `ses_result${String(index)}`,
                title: `Result ${String(index)}`,
                time: { updated: 10 - index },
                location: { directory },
              })),
            })
          },
        }),
      ),
    )
    const service = makeOpenCodeConnectionService({ run }, repositories)

    const sessions = await Effect.runPromise(
      service.listSessions(
        ListOpenCodeSessionsRequest.make({ projectId, search: Option.some("review") }),
      ),
    )

    expect(sessions).toHaveLength(5)
    expect(sessions[0]?.title).toBe("Result 0")
  })

  it("rejects a missing session before inspecting plan mode", async () => {
    const run = vi.fn<OpenCodeApiCommand["run"]>(() =>
      Effect.succeed(JSON.stringify({ _tag: "SessionNotFoundError", sessionID: sessionId })),
    )
    const service = makeOpenCodeConnectionService({ run }, repositories)

    await expect(
      Effect.runPromise(
        service.connect(ConnectOpenCodeSessionRequest.make({ sessionId, projectId })),
      ),
    ).rejects.toMatchObject({ safeMessage: "OpenCode could not find this session." })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("rejects a different session returned by the lookup", async () => {
    const run = vi.fn<OpenCodeApiCommand["run"]>(() =>
      Effect.succeed(JSON.stringify({ data: { id: "ses_different", location: { directory } } })),
    )
    const service = makeOpenCodeConnectionService({ run }, repositories)

    await expect(
      Effect.runPromise(
        service.connect(ConnectOpenCodeSessionRequest.make({ sessionId, projectId })),
      ),
    ).rejects.toMatchObject({ safeMessage: "OpenCode returned an unexpected session." })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("rejects a session returned from another project checkout", async () => {
    const run = vi.fn<OpenCodeApiCommand["run"]>(() =>
      Effect.succeed(
        JSON.stringify({ data: { id: sessionId, location: { directory: "/other" } } }),
      ),
    )
    const service = makeOpenCodeConnectionService({ run }, repositories)

    await expect(
      Effect.runPromise(
        service.connect(ConnectOpenCodeSessionRequest.make({ sessionId, projectId })),
      ),
    ).rejects.toMatchObject({
      safeMessage: "This OpenCode session belongs to a different project checkout.",
    })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("connects without switching when plan mode is unavailable", async () => {
    const run = vi.fn<OpenCodeApiCommand["run"]>((request) =>
      Effect.succeed(
        OpenCodeApiRequest.match(request, {
          Post: () => "unexpected post",
          Get: ({ path }) => (path.startsWith("/api/session/") ? sessionResponse : unavailablePlan),
        }),
      ),
    )
    const service = makeOpenCodeConnectionService({ run }, repositories)

    await expect(
      Effect.runPromise(
        service.connect(ConnectOpenCodeSessionRequest.make({ sessionId, projectId })),
      ),
    ).resolves.toMatchObject({ sessionId, planMode: false })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("fails connection when an advertised plan switch is rejected", async () => {
    const run = vi.fn<OpenCodeApiCommand["run"]>((request) =>
      Effect.succeed(
        OpenCodeApiRequest.match(request, {
          Get: ({ path }) =>
            path.startsWith("/api/session/")
              ? sessionResponse
              : JSON.stringify({ data: { id: "plan", mode: "primary", hidden: false } }),
          Post: () => JSON.stringify({ _tag: "SessionNotFoundError", sessionID: sessionId }),
        }),
      ),
    )
    const service = makeOpenCodeConnectionService({ run }, repositories)

    await expect(
      Effect.runPromise(
        service.connect(ConnectOpenCodeSessionRequest.make({ sessionId, projectId })),
      ),
    ).rejects.toMatchObject({
      safeMessage: "OpenCode could not switch this session to the plan agent.",
    })
  })

  it("formats and accepts an exact multiline code prompt", async () => {
    const run = vi.fn<OpenCodeApiCommand["run"]>((request) =>
      Effect.succeed(
        OpenCodeApiRequest.match(request, {
          Post: ({ path, body }) => {
            if (path.endsWith("/agent")) return ""
            expect(JSON.parse(body)).toEqual({
              text: [
                "Source: DiffDash code line",
                "Project: project",
                `Revision: ${"0".repeat(40)}`,
                "Path: src/example.ts",
                "Line: 3",
                "Line content:",
                "return value",
                "",
                "User comment:",
                "Please explain.",
                "",
                "- Is this safe?",
              ].join("\n"),
            })
            return JSON.stringify({ data: { id: "msg_example", sessionID: sessionId } })
          },
          Get: ({ path }) => (path.startsWith("/api/session/") ? sessionResponse : unavailablePlan),
        }),
      ),
    )
    const service = makeOpenCodeConnectionService({ run }, repositories)
    await Effect.runPromise(
      service.connect(ConnectOpenCodeSessionRequest.make({ sessionId, projectId })),
    )

    await expect(
      Effect.runPromise(
        service.forwardComment({
          projectId,
          sessionId,
          subject: CommentSubject.cases.CodeLine.make({
            projectId,
            revision: GitCommitSha.make("0".repeat(40)),
            path: RepositoryRelativePath.make("src/example.ts"),
            lineNumber: 3,
            lineContent: "return value",
          }),
          body: MarkdownBody.make("Please explain.\n\n- Is this safe?"),
        }),
      ),
    ).resolves.toBeUndefined()
  })

  it("rejects successful command output containing an OpenCode error", async () => {
    const run = vi.fn<OpenCodeApiCommand["run"]>((request) =>
      Effect.succeed(
        OpenCodeApiRequest.match(request, {
          Get: ({ path }) => (path.startsWith("/api/session/") ? sessionResponse : unavailablePlan),
          Post: () => JSON.stringify({ _tag: "SessionNotFoundError", sessionID: sessionId }),
        }),
      ),
    )
    const service = makeOpenCodeConnectionService({ run }, repositories)
    await Effect.runPromise(
      service.connect(ConnectOpenCodeSessionRequest.make({ sessionId, projectId })),
    )

    await expect(
      Effect.runPromise(
        service.forwardComment({
          projectId,
          sessionId,
          subject: CommentSubject.cases.CodeLine.make({
            projectId,
            revision: GitCommitSha.make("0".repeat(40)),
            path: RepositoryRelativePath.make("src/example.ts"),
            lineNumber: 3,
            lineContent: "return value",
          }),
          body: MarkdownBody.make("Please explain"),
        }),
      ),
    ).rejects.toMatchObject({ safeMessage: "OpenCode did not accept this comment." })
  })

  it("rejects renderer-invented and cross-project selections before prompting", async () => {
    const run = vi.fn<OpenCodeApiCommand["run"]>(() => Effect.die("Command must not run"))
    const service = makeOpenCodeConnectionService({ run }, repositories)

    await expect(
      Effect.runPromise(
        service.forwardComment({
          projectId: ReviewProjectId.make("other-project"),
          sessionId,
          subject: CommentSubject.cases.CodeLine.make({
            projectId: ReviewProjectId.make("other-project"),
            revision: GitCommitSha.make("0".repeat(40)),
            path: RepositoryRelativePath.make("src/example.ts"),
            lineNumber: 3,
            lineContent: "return value",
          }),
          body: MarkdownBody.make("Please explain"),
        }),
      ),
    ).rejects.toMatchObject({
      safeMessage: "Reconnect this OpenCode session before forwarding comments.",
    })
    expect(run).not.toHaveBeenCalled()
  })

  it("invalidates a connection when the authoritative linked checkout changes", async () => {
    let currentDirectory = directory
    const currentRepositories = {
      getById: () => Effect.succeed(repositoryAt(currentDirectory)),
    }
    const run = vi.fn<OpenCodeApiCommand["run"]>((request) =>
      Effect.succeed(
        OpenCodeApiRequest.match(request, {
          Get: ({ path }) => (path.startsWith("/api/session/") ? sessionResponse : unavailablePlan),
          Post: () => "",
        }),
      ),
    )
    const service = makeOpenCodeConnectionService({ run }, currentRepositories)
    await Effect.runPromise(
      service.connect(ConnectOpenCodeSessionRequest.make({ sessionId, projectId })),
    )
    currentDirectory = RepositoryCheckoutPath.make("/workspace-moved")

    await expect(
      Effect.runPromise(
        service.forwardComment({
          projectId,
          sessionId,
          subject: CommentSubject.cases.CodeLine.make({
            projectId,
            revision: GitCommitSha.make("0".repeat(40)),
            path: RepositoryRelativePath.make("src/example.ts"),
            lineNumber: 3,
            lineContent: "return value",
          }),
          body: MarkdownBody.make("Please explain"),
        }),
      ),
    ).rejects.toMatchObject({
      safeMessage: "Reconnect this OpenCode session after changing the linked checkout.",
    })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("forwards complete review target, revision, and anchor context", async () => {
    const anchor = LineReviewAnchor.make({
      fileId: ReviewFileId.make("file-1"),
      filePath: RepositoryRelativePath.make("src/example.ts"),
      oldPath: null,
      hunkId: ReviewHunkId.make("hunk-1"),
      hunkFingerprint: ReviewHunkFingerprint.make("fingerprint-1"),
      hunkHeader: "@@ -2 +2 @@",
      side: "new",
      lineNumber: 3,
      lineContent: "return value",
    })
    const run = vi.fn<OpenCodeApiCommand["run"]>((request) =>
      Effect.succeed(
        OpenCodeApiRequest.match(request, {
          Get: ({ path }) => (path.startsWith("/api/session/") ? sessionResponse : unavailablePlan),
          Post: ({ body }) => {
            const decoded = Schema.decodeUnknownSync(
              Schema.Struct({ text: Schema.optionalKey(Schema.String) }),
            )(JSON.parse(body))
            if (decoded.text === undefined) return ""
            expect(decoded.text).toContain("Source: DiffDash review line")
            expect(decoded.text).toContain("Base revision: base")
            expect(decoded.text).toContain("Head revision: head")
            expect(decoded.text).toContain('"kind": "local"')
            expect(decoded.text).toContain('"hunkHeader": "@@ -2 +2 @@"')
            expect(decoded.text).toContain('"lineContent": "return value"')
            return JSON.stringify({ data: { id: "msg_example", sessionID: sessionId } })
          },
        }),
      ),
    )
    const service = makeOpenCodeConnectionService({ run }, repositories)
    await Effect.runPromise(
      service.connect(ConnectOpenCodeSessionRequest.make({ sessionId, projectId })),
    )

    await Effect.runPromise(
      service.forwardComment({
        projectId,
        sessionId,
        subject: CommentSubject.cases.ReviewLine.make({
          target: workingTreeReviewTarget(directory),
          expectedBaseRevision: ReviewRevision.make("base"),
          expectedHeadRevision: ReviewRevision.make("head"),
          anchor,
        }),
        body: MarkdownBody.make("Please explain"),
      }),
    )
  })
})
