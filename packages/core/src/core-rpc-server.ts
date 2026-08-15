import { AppStateBusinessRpcs } from "@diffdash/core-rpc/business"
import { CoreControlRpcs } from "@diffdash/core-rpc/control"
import {
  AuthenticatedCoreWalkthroughServerRpcs,
  AuthenticatedCoreReviewAgentServerRpcs,
  AuthenticatedCoreServerRpcs,
  AuthenticatedCoreStateDeliveryServerRpcs,
} from "@diffdash/core-rpc/transport"
import { Layer } from "effect"
import * as RpcServer from "effect/unstable/rpc/RpcServer"

import { coreBusinessRpcHandlersLayer } from "./core-business-rpc-handlers"
import { coreControlRpcHandlersLayer } from "./core-control-rpc-handlers"
import { coreWalkthroughRpcHandlersLayer } from "./core-walkthrough-rpc-handlers"
import { coreReviewAgentRpcHandlersLayer } from "./core-review-agent-rpc-handlers"
import { coreStateDeliveryRpcHandlersLayer } from "./core-state-delivery-rpc-handlers"
import { coreRpcAdmissionLayer } from "./core-rpc-admission"
import {
  CoreAuthenticatedHostSession,
  coreAuthenticatedHostSessionLayer,
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
export const coreRpcServerLayer = (
  authentication: CoreTransportAuthenticationOptions,
  hostSessionLayer: Layer.Layer<CoreAuthenticatedHostSession> = coreAuthenticatedHostSessionLayer,
) =>
  RpcServer.layer(CoreServerRpcs).pipe(
    Layer.provide(
      Layer.mergeAll(
        coreControlRpcHandlersLayer,
        coreBusinessRpcHandlersLayer,
        coreRpcAdmissionLayer,
        coreTransportAuthenticationLayer(authentication),
      ),
    ),
    Layer.provideMerge(hostSessionLayer),
  )

/** Runs the durable walkthrough RPC audience when an operation runtime is available. */
export const coreWalkthroughRpcServerLayer = (
  authentication: CoreTransportAuthenticationOptions,
  hostSessionLayer: Layer.Layer<CoreAuthenticatedHostSession> = coreAuthenticatedHostSessionLayer,
) =>
  RpcServer.layer(AuthenticatedCoreWalkthroughServerRpcs).pipe(
    Layer.provide(
      Layer.mergeAll(
        coreControlRpcHandlersLayer,
        coreWalkthroughRpcHandlersLayer,
        coreRpcAdmissionLayer,
        coreTransportAuthenticationLayer(authentication),
      ),
    ),
    Layer.provideMerge(hostSessionLayer),
  )

/** Runs durable review-agent lifecycle RPCs when the Core operation runtime is available. */
export const coreReviewAgentRpcServerLayer = (
  authentication: CoreTransportAuthenticationOptions,
  hostSessionLayer: Layer.Layer<CoreAuthenticatedHostSession> = coreAuthenticatedHostSessionLayer,
) =>
  RpcServer.layer(AuthenticatedCoreReviewAgentServerRpcs).pipe(
    Layer.provide(
      Layer.mergeAll(
        coreControlRpcHandlersLayer,
        coreReviewAgentRpcHandlersLayer,
        coreRpcAdmissionLayer,
        coreTransportAuthenticationLayer(authentication),
      ),
    ),
    Layer.provideMerge(hostSessionLayer),
  )

/** Runs event replay and durable command RPCs when their Core authorities are available. */
export const coreStateDeliveryRpcServerLayer = (
  authentication: CoreTransportAuthenticationOptions,
  hostSessionLayer: Layer.Layer<CoreAuthenticatedHostSession> = coreAuthenticatedHostSessionLayer,
) =>
  RpcServer.layer(AuthenticatedCoreStateDeliveryServerRpcs).pipe(
    Layer.provide(
      Layer.mergeAll(
        coreControlRpcHandlersLayer,
        coreStateDeliveryRpcHandlersLayer,
        coreRpcAdmissionLayer,
        coreTransportAuthenticationLayer(authentication),
      ),
    ),
    Layer.provideMerge(hostSessionLayer),
  )
