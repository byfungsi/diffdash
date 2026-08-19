import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import {
  HostedRepositorySource,
  LocalRepositorySource,
  makeHostedRepositoryLocator,
} from "./git-provider"
import {
  LinkedCheckout,
  RemoteOnly,
  Repo,
  RepositoryCheckoutPath,
  UpsertRepositoryInput,
} from "./repository"
import { ReviewProjectId } from "./review-identity"

const repositoryRecord = {
  id: "github:fungsi/diffdash",
  source: {
    _tag: "hosted",
    locator: { providerId: "github", namespace: "fungsi", name: "diffdash" },
  },
  isFavorite: false,
  lastOpenedAt: null,
  lastSyncedAt: null,
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
} as const

describe("Repo", () => {
  it("preserves transport-safe checkout variants", () => {
    const present = Schema.decodeUnknownSync(Repo)({
      ...repositoryRecord,
      checkout: {
        _tag: "LinkedCheckout",
        remoteUrl: "https://github.com/fungsi/diffdash",
        path: "/workspace/diffdash",
      },
    })
    const absent = Schema.decodeUnknownSync(Repo)({
      ...repositoryRecord,
      checkout: {
        _tag: "RemoteOnly",
        remoteUrl: "https://github.com/fungsi/diffdash",
      },
    })

    expect(present.localPath).toBe("/workspace/diffdash")
    expect(absent.localPath).toBeNull()
    expect(Schema.encodeSync(Repo)(present)).toMatchObject({
      checkout: { _tag: "LinkedCheckout", path: "/workspace/diffdash" },
    })
    expect(Schema.encodeSync(Repo)(absent)).toMatchObject({
      checkout: { _tag: "RemoteOnly" },
    })
  })

  it("requires checkout and an absolute linked path", () => {
    expect(() => Schema.decodeUnknownSync(Repo)(repositoryRecord)).toThrow(/checkout/)
    expect(() =>
      Schema.decodeUnknownSync(Repo)({
        ...repositoryRecord,
        checkout: {
          _tag: "LinkedCheckout",
          remoteUrl: "https://github.com/fungsi/diffdash",
          path: "relative/repository",
        },
      }),
    ).toThrow(/absolute repository checkout path/)
    expect(
      Repo.make({
        ...repositoryRecord,
        id: ReviewProjectId.make(repositoryRecord.id),
        source: HostedRepositorySource.make({
          locator: makeHostedRepositoryLocator("github", "fungsi", "diffdash"),
        }),
        checkout: LinkedCheckout.make({
          remoteUrl: "https://github.com/fungsi/diffdash",
          path: RepositoryCheckoutPath.make("/workspace/diffdash"),
        }),
      }).localPath,
    ).toBe(RepositoryCheckoutPath.make("/workspace/diffdash"))
  })

  it("rejects a local source without a linked checkout", () => {
    const input = {
      source: { _tag: "local" },
      checkout: { _tag: "RemoteOnly", remoteUrl: "file:///workspace/diffdash" },
      favorite: "preserve",
    }

    expect(() => Schema.decodeUnknownSync(UpsertRepositoryInput)(input)).toThrow(
      /local repository source requires a linked checkout/i,
    )
    expect(() =>
      Repo.make({
        ...repositoryRecord,
        id: ReviewProjectId.make(repositoryRecord.id),
        source: LocalRepositorySource.make(),
        checkout: RemoteOnly.make({ remoteUrl: "file:///workspace/diffdash" }),
      }),
    ).toThrow("Schema validation failed")
  })

  it("rejects malformed hosted repository sources", () => {
    expect(() =>
      Schema.decodeUnknownSync(UpsertRepositoryInput)({
        source: {
          _tag: "hosted",
          locator: { providerId: "local", namespace: "bad:owner", name: "bad/name" },
        },
        checkout: {
          _tag: "RemoteOnly",
          remoteUrl: "https://example.test/bad/repository",
        },
        favorite: "preserve",
      }),
    ).toThrow(/Expected a string matching.*at \["source"\]\["locator"\]\["providerId"\]/s)
  })

  it("requires an explicit preserve-or-mark favorite intent", () => {
    const input = {
      source: {
        _tag: "hosted",
        locator: { providerId: "github", namespace: "fungsi", name: "diffdash" },
      },
      checkout: {
        _tag: "RemoteOnly",
        remoteUrl: "https://github.com/fungsi/diffdash",
      },
    }

    expect(() => Schema.decodeUnknownSync(UpsertRepositoryInput)(input)).toThrow(/favorite/)
    expect(() =>
      Schema.decodeUnknownSync(UpsertRepositoryInput)({ ...input, favorite: false }),
    ).toThrow(/preserve.*mark|mark.*preserve/s)
    expect(
      Schema.decodeUnknownSync(UpsertRepositoryInput)({ ...input, favorite: "mark" }).favorite,
    ).toBe("mark")
  })

  it("centralizes hosted equality and display identity", () => {
    const repo = Schema.decodeUnknownSync(Repo)({
      ...repositoryRecord,
      checkout: {
        _tag: "RemoteOnly",
        remoteUrl: "https://github.com/fungsi/diffdash",
      },
    })

    expect(repo.matchesHosted(makeHostedRepositoryLocator("github", "FUNGSI", "DiffDash"))).toBe(
      true,
    )
    expect(repo.displayIdentity).toBe("fungsi/diffdash")
    expect(repo.remoteUrl).toBe("https://github.com/fungsi/diffdash")
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
