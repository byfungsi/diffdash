import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { Repo, RepositoryCheckoutPath } from "./repository"

const repositoryRecord = {
  id: "github:fungsi/diffdash",
  provider: "github",
  owner: "fungsi",
  name: "diffdash",
  remoteUrl: "https://github.com/fungsi/diffdash",
  isFavorite: false,
  lastOpenedAt: null,
  lastSyncedAt: null,
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
} as const

describe("Repo", () => {
  it("preserves transport-safe nullable checkout paths", () => {
    const present = Schema.decodeUnknownSync(Repo)({
      ...repositoryRecord,
      localPath: "/workspace/diffdash",
    })
    const absent = Schema.decodeUnknownSync(Repo)({ ...repositoryRecord, localPath: null })

    expect(present.localPath).toBe("/workspace/diffdash")
    expect(absent.localPath).toBeNull()
    expect(Schema.encodeSync(Repo)(present)).toMatchObject({ localPath: "/workspace/diffdash" })
    expect(Schema.encodeSync(Repo)(absent)).toMatchObject({ localPath: null })
  })

  it("requires the persisted localPath field and an absolute present path", () => {
    expect(() => Schema.decodeUnknownSync(Repo)(repositoryRecord)).toThrow(/localPath/)
    expect(() =>
      Schema.decodeUnknownSync(Repo)({ ...repositoryRecord, localPath: "relative/repository" }),
    ).toThrow(/absolute repository checkout path/)
    expect(
      Repo.make({
        ...repositoryRecord,
        localPath: RepositoryCheckoutPath.make("/workspace/diffdash"),
      }).localPath,
    ).toBe(RepositoryCheckoutPath.make("/workspace/diffdash"))
  })

  it("accepts POSIX, Windows drive, and UNC checkout paths", () => {
    expect(Schema.decodeUnknownSync(RepositoryCheckoutPath)("/workspace/diffdash")).toBe(
      "/workspace/diffdash",
    )
    expect(Schema.decodeUnknownSync(RepositoryCheckoutPath)("C:\\workspace\\diffdash")).toBe(
      "C:\\workspace\\diffdash",
    )
    expect(Schema.decodeUnknownSync(RepositoryCheckoutPath)("\\\\server\\share\\diffdash")).toBe(
      "\\\\server\\share\\diffdash",
    )
    expect(() => Schema.decodeUnknownSync(RepositoryCheckoutPath)("C:relative")).toThrow(
      /absolute repository checkout path/,
    )
  })
})
