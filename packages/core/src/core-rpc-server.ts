import { CoreBusinessRpcs } from "@diffdash/core-rpc/business"
import { CoreControlRpcs } from "@diffdash/core-rpc/control"
import { Layer } from "effect"
import * as RpcServer from "effect/unstable/rpc/RpcServer"

import { coreBusinessRpcHandlersLayer } from "./core-business-rpc-handlers"
import { coreControlRpcHandlersLayer } from "./core-control-rpc-handlers"
import { coreRpcAdmissionLayer } from "./core-rpc-admission"

const inboundGroups = [CoreControlRpcs, CoreBusinessRpcs] as const
const inboundTags = inboundGroups.flatMap((group) => Array.from(group.requests.keys()))
if (new Set(inboundTags).size !== inboundTags.length) {
  throw new Error("Core RPC audience groups must use disjoint method tags.")
}

const CoreServerRpcs = CoreControlRpcs.merge(CoreBusinessRpcs)

/** Runs the privileged Core RPC groups through one transport-neutral native server. */
export const coreRpcServerLayer = RpcServer.layer(CoreServerRpcs).pipe(
  Layer.provide(
    Layer.mergeAll(
      coreControlRpcHandlersLayer,
      coreBusinessRpcHandlersLayer,
      coreRpcAdmissionLayer,
    ),
  ),
)
