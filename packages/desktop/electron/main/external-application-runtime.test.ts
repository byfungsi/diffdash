import { CodeWorkspaceError } from "@diffdash/domain/code-workspace"
import { Effect } from "effect"
import { RpcClientDefect, RpcClientError } from "effect/unstable/rpc/RpcClientError"
import { describe, expect, it } from "vitest"

import { runExternalCoreOperationPromise } from "./external-application-runtime"

describe("external application runtime response boundary", () => {
  it("rejects with the original expected Core failure", async () => {
    const failure = CodeWorkspaceError.make({
      operation: "open",
      reason: "revisionUnavailable",
      message: "The workspace revision is unavailable.",
    })

    await expect(runExternalCoreOperationPromise(Effect.fail(failure))).rejects.toBe(failure)
  })

  it("rejects with a structured remote Core defect", async () => {
    const failure = {
      _tag: "CoreApplicationFailure",
      code: "CODE_WORKSPACE_REVISION_UNAVAILABLE",
      safeMessage: "Git could not resolve the repository's current revision.",
    }

    await expect(runExternalCoreOperationPromise(Effect.die(failure))).rejects.toBe(failure)
  })

  it("unwraps a structured defect from the RPC client wrapper", async () => {
    const failure = {
      _tag: "CoreApplicationFailure",
      code: "CODE_WORKSPACE_REVISION_UNAVAILABLE",
      safeMessage: "Git could not resolve the repository's current revision.",
    }
    const rpcFailure = new RpcClientError({
      reason: new RpcClientDefect({ message: "Remote defect", cause: failure }),
    })

    await expect(runExternalCoreOperationPromise(Effect.fail(rpcFailure))).rejects.toBe(failure)
  })

  it("unwraps a directly decoded RPC client defect", async () => {
    const failure = {
      _tag: "CoreApplicationFailure",
      code: "CODE_WORKSPACE_REVISION_UNAVAILABLE",
      safeMessage: "Git could not resolve the repository's current revision.",
    }
    const rpcFailure = new RpcClientDefect({ message: "Remote defect", cause: failure })

    await expect(runExternalCoreOperationPromise(Effect.die(rpcFailure))).rejects.toBe(failure)
  })
})
