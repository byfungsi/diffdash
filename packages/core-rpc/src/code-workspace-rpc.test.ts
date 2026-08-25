import { CodeWorkspaceLeaseId } from "@diffdash/domain/code-workspace"
import { LocalCheckoutFileChunk } from "@diffdash/domain/local-checkout-file"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { describe, expect, it } from "@effect/vitest"
import { Option, Schema } from "effect"

import {
  CoreCodeWorkspaceFileAdmissionMiddleware,
  CoreCodeWorkspaceFileRequest,
  CoreCodeWorkspaceFileRpcs,
} from "./code-workspace-rpc"
import { ApplicationInstanceId, CoreProcessEpoch, HostRequestId } from "./identity"
import { getCoreRpcMethodPolicy } from "./method-policy"

describe("Core Code workspace file RPC declaration", () => {
  it("defines one bounded interruptible project stream", () => {
    expect([...CoreCodeWorkspaceFileRpcs.requests.keys()]).toEqual(["CodeWorkspace.streamFile"])
    const declaration = CoreCodeWorkspaceFileRpcs.requests.get("CodeWorkspace.streamFile")
    expect(declaration).toBeDefined()
    if (declaration === undefined) return
    expect(declaration.middlewares).toEqual(new Set([CoreCodeWorkspaceFileAdmissionMiddleware]))
    const policy = getCoreRpcMethodPolicy(declaration)
    expect(Option.isSome(policy)).toBe(true)
    if (Option.isNone(policy)) return
    expect(policy.value).toMatchObject({
      cancellation: "interruptible",
      maxResponseBytes: 384 * 1_024,
      requiredScope: "project",
    })
  })

  it("round-trips request identity and structured-clone binary chunks", () => {
    const path = RepositoryRelativePath.make("src/large.ts")
    const request = CoreCodeWorkspaceFileRequest.make({
      applicationInstanceId: ApplicationInstanceId.make("app-code-file"),
      processEpoch: CoreProcessEpoch.make("epoch-code-file"),
      requestId: HostRequestId.make("h:code-file"),
      leaseId: CodeWorkspaceLeaseId.make("lease:code-file"),
      path,
    })
    const chunk = LocalCheckoutFileChunk.make({ path, bytes: Uint8Array.from([0, 1, 255]) })

    expect(
      Schema.decodeSync(CoreCodeWorkspaceFileRequest)(
        Schema.encodeSync(CoreCodeWorkspaceFileRequest)(request),
      ),
    ).toEqual(request)
    expect(
      Schema.decodeSync(LocalCheckoutFileChunk)(Schema.encodeSync(LocalCheckoutFileChunk)(chunk)),
    ).toEqual(chunk)
  })
})
