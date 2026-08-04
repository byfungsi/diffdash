import { GitProviderDiagnostic } from "@diffdash/domain/git-provider"
import { GitProviderRegistry } from "@diffdash/git-provider"
import { createFixtureGitProvider } from "@diffdash/git-provider-fixture"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { GitProvider } from "./git-provider"

describe("GitProvider", () => {
  it.effect("requires provider support and authentication for remote acquisition", () => {
    const fixture = createFixtureGitProvider()
    const layer = GitProvider.layer.pipe(
      Layer.provide(
        GitProviderRegistry.layer([
          {
            ...fixture,
            diagnose: Effect.succeed(
              GitProviderDiagnostic.make({
                providerId: fixture.descriptor.id,
                available: true,
                authenticated: false,
                message: "Authenticate the fixture provider.",
              }),
            ),
          },
        ]),
      ),
    )

    return Effect.gen(function* () {
      const providers = yield* GitProvider
      expect(yield* providers.isAvailable(fixture.descriptor.id)).toBe(false)
    }).pipe(Effect.provide(layer))
  })
})
