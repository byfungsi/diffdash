import { expect, it } from "vitest"
import { createCloudAnalytics } from "./cloud-analytics"

it("sends only approved properties and suppresses credentials and referrers", async () => {
  const requests: RequestInit[] = []
  const capture = createCloudAnalytics({
    projectKey: "phc_fixture",
    host: "https://us.i.posthog.com",
    distinctId: () => "anonymous-fixture",
    request: async (url, init) => {
      expect(url).toBe("https://us.i.posthog.com/capture/")
      if (init !== undefined) requests.push(init)
      return new Response("{}")
    },
  })
  const event = {
    event: "review_opened" as const,
    reviewType: "pull_request" as const,
    token: "secret-fixture",
    path: "/private/repo",
    body: "private note",
  }
  await capture(event)
  expect(requests).toHaveLength(1)
  expect(requests[0]?.credentials).toBe("omit")
  expect(requests[0]?.referrerPolicy).toBe("no-referrer")
  expect(requests[0]?.body).toBe(
    JSON.stringify({
      api_key: "phc_fixture",
      event: "review_opened",
      properties: {
        app: "cloud",
        distinct_id: "anonymous-fixture",
        $process_person_profile: false,
        $geoip_disable: true,
        reviewType: "pull_request",
      },
    }),
  )
})

it("does not send events or allocate identity without valid configuration", async () => {
  for (const [projectKey, host] of [
    ["", "https://us.i.posthog.com"],
    ["phc_fixture", "https://untrusted.example"],
  ]) {
    let identities = 0
    let requests = 0
    const capture = createCloudAnalytics({
      projectKey: projectKey ?? "",
      host: host ?? "",
      distinctId: () => {
        identities += 1
        return "fixture"
      },
      request: async () => {
        requests += 1
        return new Response("{}")
      },
    })
    await expect(capture({ event: "cloud_opened" })).resolves.toBeUndefined()
    expect(identities).toBe(0)
    expect(requests).toBe(0)
  }
})

it("contains telemetry failures rather than breaking product operations", async () => {
  const capture = createCloudAnalytics({
    projectKey: "phc_fixture",
    host: "https://eu.i.posthog.com",
    distinctId: () => "fixture",
    request: async () => {
      throw new Error("Network offline")
    },
  })
  await expect(capture({ event: "note_created" })).resolves.toBeUndefined()
})
