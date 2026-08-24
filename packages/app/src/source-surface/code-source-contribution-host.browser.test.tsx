import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import { Option } from "effect"
import { useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  type CodeSourceContributionOutput,
  TrustedExtensionContributionId,
  TrustedExtensionId,
} from "@/extensions/extension-registry"
import {
  useCodeSourceContributionHost,
  useCodeSourceContributionRegistration,
} from "./code-source-contribution-host"

const contributionId = TrustedExtensionContributionId.make("diffdash.test.shared.code-source")
const firstOwnerId = TrustedExtensionId.make("diffdash.test.first-owner")
const secondOwnerId = TrustedExtensionId.make("diffdash.test.second-owner")
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
})

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
    [{ id: contributionId, order: 1, ownerExtensionId, component: Probe }],
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
