import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { Option, Result } from "effect"
import { useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  type CodeSourceContributionOutput,
  makeTrustedExtensionRegistry,
  type TrustedBuiltInExtension,
  TrustedExtensionContributionId,
  TrustedExtensionId,
  TrustedExtensionRegistrationToken,
} from "@/extensions/extension-registry"
import {
  TrustedExtensionRegistryProvider,
  useTrustedExtensionRegistry,
} from "@/extensions/extension-registry-context"
import { codeExtension } from "@/extensions/code/code-extension"
import {
  useCodeSourceContributionHost,
  useCodeSourceContributionRegistration,
} from "./code-source-contribution-host"

const contributionId = TrustedExtensionContributionId.make("diffdash.test.shared.code-source")
const firstOwnerId = TrustedExtensionId.make("diffdash.test.first-owner")
const secondOwnerId = TrustedExtensionId.make("diffdash.test.second-owner")
const firstOwnerRegistrationToken = new TrustedExtensionRegistrationToken()
const secondOwnerRegistrationToken = new TrustedExtensionRegistrationToken()
const source = {
  projectId: ReviewProjectId.make("source-host-project"),
  workspaceRevision: ReviewRevision.make("1".repeat(40)),
  gitRevision: Option.none(),
  path: RepositoryRelativePath.make("src/example.ts"),
}
const output: CodeSourceContributionOutput = {
  handleLineAction: () => false,
  annotation: Option.none(),
}

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

describe("Code source contribution host", () => {
  it("remounts a reused contribution ID when extension ownership changes", async () => {
    const mounted = vi.fn<() => void>()
    const unmounted = vi.fn<() => void>()
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    root.render(<Host ownerExtensionId={firstOwnerId} mounted={mounted} unmounted={unmounted} />)
    await vi.waitFor(() => expect(mounted).toHaveBeenCalledOnce())

    root.render(<Host ownerExtensionId={secondOwnerId} mounted={mounted} unmounted={unmounted} />)
    await vi.waitFor(() => {
      expect(unmounted).toHaveBeenCalledOnce()
      expect(mounted).toHaveBeenCalledTimes(2)
    })
  })

  it("disposes and remounts a contribution across same-tick registration turnover", async () => {
    const mounted = vi.fn<() => void>()
    const unmounted = vi.fn<() => void>()
    const extensionId = TrustedExtensionId.make("diffdash.test.code-source-turnover")
    activeMounted = mounted
    activeUnmounted = unmounted
    const extension: TrustedBuiltInExtension = {
      id: extensionId,
      codeSourceContributions: [
        {
          id: contributionId,
          order: 1,
          component: Probe,
        },
      ],
    }
    const registry = Result.getOrThrow(makeTrustedExtensionRegistry([codeExtension, extension]))
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      <TrustedExtensionRegistryProvider extensions={[]} registry={registry}>
        <RegistryHost />
      </TrustedExtensionRegistryProvider>,
    )

    await vi.waitFor(() => expect(mounted).toHaveBeenCalledOnce())
    expect(registry.unregister(extensionId)).toBe(true)
    Result.getOrThrow(registry.register(extension))

    await vi.waitFor(() => {
      expect(unmounted).toHaveBeenCalledOnce()
      expect(mounted).toHaveBeenCalledTimes(2)
    })
  })
})

const RegistryHost = () => {
  const { codeSourceContributions } = useTrustedExtensionRegistry()
  const host = useCodeSourceContributionHost(codeSourceContributions, source)
  return <>{host.mounts}</>
}

const Host = ({
  ownerExtensionId,
  mounted,
  unmounted,
}: {
  readonly ownerExtensionId: typeof firstOwnerId
  readonly mounted: () => void
  readonly unmounted: () => void
}) => {
  activeMounted = mounted
  activeUnmounted = unmounted
  const host = useCodeSourceContributionHost(
    [
      {
        id: contributionId,
        order: 1,
        ownerExtensionId,
        ownerRegistrationToken:
          ownerExtensionId === firstOwnerId
            ? firstOwnerRegistrationToken
            : secondOwnerRegistrationToken,
        component: Probe,
      },
    ],
    source,
  )
  return <>{host.mounts}</>
}

let activeMounted: () => void = () => undefined
let activeUnmounted: () => void = () => undefined

const Probe = () => {
  useCodeSourceContributionRegistration(output)
  useEffect(() => {
    activeMounted()
    return () => activeUnmounted()
  }, [])
  return null
}
