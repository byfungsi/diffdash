import { CoreTransportAuthenticationMiddleware } from "./admission"
import { AppStateBusinessRpcs, AppStateUpdateRpcs, CoreBusinessRpcs } from "./business"
import { CoreControlRpcs } from "./control"
import { CoreStateDeliveryRpcs } from "./event-rpc"
import { WalkthroughBusinessRpcs } from "./walkthrough-rpc"
import { ReviewAgentBusinessRpcs, ReviewAgentStartRpc } from "./review-agent-rpc"
import { CoreApplicationRpcs } from "./application-rpc"
import { CoreProgressiveReviewRpcs } from "./review-session-rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

/** Private native RPC header carrying the one-time Core transport credential. */
export const CORE_TRANSPORT_TOKEN_HEADER = "x-diffdash-core-token"

/** Maximum native MessagePack input retained while waiting for a complete RPC frame. */
export const CORE_RPC_INCOMPLETE_BUFFER_BYTES = 512 * 1_024

/** Aggregate upper bound for native Core transport work retained in flight. */
export const CORE_RPC_IN_FLIGHT_BYTES = 16 * 1_024 * 1_024

/** Maximum concurrent native RPC requests selected by the M21 transport prototype. */
export const CORE_RPC_MAX_CONCURRENCY = 32

/** Walkthrough RPC is unary, so no application stream chunk may be emitted. */
export const CORE_RPC_STREAM_CHUNK_BYTES = 0

/** Walkthrough RPC is unary, so no application stream acknowledgement may remain outstanding. */
export const CORE_RPC_STREAM_ACK_WINDOW = 0

/** Electron-to-Core control declarations projected through transport authentication. */
export const AuthenticatedCoreControlRpcs = CoreControlRpcs.middleware(
  CoreTransportAuthenticationMiddleware,
)

/** Electron-to-Core business declarations projected through transport authentication. */
export const AuthenticatedCoreBusinessRpcs = CoreBusinessRpcs.middleware(
  CoreTransportAuthenticationMiddleware,
)

/** Authenticated application methods not owned by a specialized native group. */
export const AuthenticatedCoreApplicationMethodRpcs = CoreApplicationRpcs.middleware(
  CoreTransportAuthenticationMiddleware,
)

const AuthenticatedAppStateBusinessRpcs = AppStateBusinessRpcs.middleware(
  CoreTransportAuthenticationMiddleware,
)

const AuthenticatedAppStateUpdateRpcs = AppStateUpdateRpcs.middleware(
  CoreTransportAuthenticationMiddleware,
)

const AuthenticatedReviewAgentStartRpcs = RpcGroup.make(
  ReviewAgentStartRpc.middleware(CoreTransportAuthenticationMiddleware),
)

/** One authenticated native declaration for every closed Core business method. */
export const AuthenticatedCoreMethodRpcs = AuthenticatedCoreApplicationMethodRpcs.merge(
  AuthenticatedAppStateBusinessRpcs,
)
  .merge(AuthenticatedAppStateUpdateRpcs)
  .merge(AuthenticatedReviewAgentStartRpcs)

/** Authenticated server group for methods backed by concrete handlers in the current Core. */
export const AuthenticatedCoreServerRpcs = AuthenticatedCoreControlRpcs.merge(
  AuthenticatedAppStateBusinessRpcs,
)

/** Authenticated walkthrough-only group used to exercise the durable application boundary. */
export const AuthenticatedWalkthroughBusinessRpcs = WalkthroughBusinessRpcs.middleware(
  CoreTransportAuthenticationMiddleware,
)

/** Authenticated control and walkthrough group for the durable walkthrough prototype. */
export const AuthenticatedCoreWalkthroughServerRpcs = AuthenticatedCoreControlRpcs.merge(
  AuthenticatedWalkthroughBusinessRpcs,
)

/** Authenticated review-agent methods backed by the durable Core operation runtime. */
export const AuthenticatedReviewAgentBusinessRpcs = ReviewAgentBusinessRpcs.middleware(
  CoreTransportAuthenticationMiddleware,
)

/** Authenticated progressive review methods backed by Core-owned snapshot storage. */
export const AuthenticatedProgressiveReviewRpcs = CoreProgressiveReviewRpcs.middleware(
  CoreTransportAuthenticationMiddleware,
)

/** Authenticated control and durable review-agent server group. */
export const AuthenticatedCoreReviewAgentServerRpcs = AuthenticatedCoreControlRpcs.merge(
  AuthenticatedReviewAgentBusinessRpcs,
)

/** Authenticated reconnect-safe event and durable command audience. */
export const AuthenticatedCoreStateDeliveryRpcs = CoreStateDeliveryRpcs.middleware(
  CoreTransportAuthenticationMiddleware,
)

/** One authenticated production catalog for control and every application operation family. */
export const AuthenticatedCoreApplicationRpcs = AuthenticatedCoreControlRpcs.merge(
  AuthenticatedCoreApplicationMethodRpcs,
)
  .merge(AuthenticatedAppStateBusinessRpcs)
  .merge(AuthenticatedAppStateUpdateRpcs)
  .merge(AuthenticatedWalkthroughBusinessRpcs)
  .merge(AuthenticatedReviewAgentBusinessRpcs)
  .merge(AuthenticatedProgressiveReviewRpcs)
  .merge(AuthenticatedCoreStateDeliveryRpcs)

/** Standalone-capable server catalog for control, event replay, and durable commands. */
export const AuthenticatedCoreStateDeliveryServerRpcs = AuthenticatedCoreControlRpcs.merge(
  AuthenticatedCoreStateDeliveryRpcs,
)

/** Standalone-capable host client catalog matching the state-delivery server audience. */
export const AuthenticatedCoreHostClientRpcs = AuthenticatedCoreApplicationRpcs
