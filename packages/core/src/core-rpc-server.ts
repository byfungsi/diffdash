import { AppStateBusinessRpcs } from "@diffdash/core-rpc/business"
import { CoreControlRpcs } from "@diffdash/core-rpc/control"
import {
  AuthenticatedCoreWalkthroughServerRpcs,
  AuthenticatedCoreServerRpcs,
} from "@diffdash/core-rpc/transport"
import { Layer } from "effect"
import * as RpcServer from "effect/unstable/rpc/RpcServer"

import { coreBusinessRpcHandlersLayer } from "./core-business-rpc-handlers"
import { coreControlRpcHandlersLayer } from "./core-control-rpc-handlers"
import { coreWalkthroughRpcHandlersLayer } from "./core-walkthrough-rpc-handlers"
import { coreRpcAdmissionLayer } from "./core-rpc-admission"
import {
  coreTransportAuthenticationLayer,
  type CoreTransportAuthenticationOptions,
} from "./core-transport-authentication"

const inboundGroups = [CoreControlRpcs, AppStateBusinessRpcs] as const
const inboundTags = inboundGroups.flatMap((group) => Array.from(group.requests.keys()))
if (new Set(inboundTags).size !== inboundTags.length) {
  throw new Error("Core RPC audience groups must use disjoint method tags.")
}

const CoreServerRpcs = AuthenticatedCoreServerRpcs

/** Runs the privileged Core RPC groups through one transport-neutral native server. */
export const coreRpcServerLayer = (authentication: CoreTransportAuthenticationOptions) =>
  RpcServer.layer(CoreServerRpcs).pipe(
    Layer.provide(
      Layer.mergeAll(
        coreControlRpcHandlersLayer,
        coreBusinessRpcHandlersLayer,
        coreRpcAdmissionLayer,
        coreTransportAuthenticationLayer(authentication),
      ),
    ),
  )

/** Runs the durable walkthrough RPC audience when an operation runtime is available. */
export const coreWalkthroughRpcServerLayer = (authentication: CoreTransportAuthenticationOptions) =>
  RpcServer.layer(AuthenticatedCoreWalkthroughServerRpcs).pipe(
    Layer.provide(
      Layer.mergeAll(
        coreControlRpcHandlersLayer,
        coreWalkthroughRpcHandlersLayer,
        coreRpcAdmissionLayer,
        coreTransportAuthenticationLayer(authentication),
      ),
    ),
  )
