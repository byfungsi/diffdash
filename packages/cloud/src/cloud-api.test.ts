import { AppUpdateState } from "@diffdash/protocol/app-update"
import { Schema } from "effect"
import { expect, it } from "vitest"
import { createCloudApi, createCloudBridge } from "./cloud-api"
import { cloudFixtureRequest } from "./cloud-review-fixtures"
import { CloudStorage } from "./cloud-storage"
import { GithubClient } from "./github-client"
import { parseGithubPersonalAccessToken } from "./github-credentials"

const cloudApi = () =>
  createCloudApi(
    new GithubClient(
      parseGithubPersonalAccessToken("github_pat_test_fixture_only"),
      cloudFixtureRequest,
    ),
    new CloudStorage(),
  )

it("encodes runtime classes and empty responses before the renderer decodes them", async () => {
  const api = cloudApi()
  const bridge = createCloudBridge(api)
  const expected = await api.updates.getState()
  const state = await bridge.updates.getState()
  expect(state._tag).toBe("Success")
  if (state._tag !== "Success") throw new Error("Cloud update state failed")
  expect(Schema.decodeUnknownSync(AppUpdateState)(structuredClone(state.value))).toEqual(expected)
  expect(await bridge.updates.check()).toEqual({ _tag: "Success", value: null })
  expect(await bridge.analytics.start()).toEqual({ _tag: "Success", value: null })
})

it("returns failure envelopes for rejected operations and synchronous defects", async () => {
  const api = cloudApi()
  const bridge = createCloudBridge({
    ...api,
    updates: {
      ...api.updates,
      getState: () => {
        throw new Error("private infrastructure detail")
      },
    },
  })
  const synchronous = await bridge.updates.getState()
  const rejected = await bridge.installDiffDashCli()
  expect(synchronous._tag).toBe("Failure")
  expect(rejected._tag).toBe("Failure")
  expect(JSON.stringify(synchronous)).not.toContain("private infrastructure detail")
})
