import { CoreTransportAuthenticationMiddleware } from "./admission"
import { AppStateBusinessRpcs, CoreBusinessRpcs } from "./business"
import { CoreControlRpcs } from "./control"

/** Private native RPC header carrying the one-time Core transport credential. */
export const CORE_TRANSPORT_TOKEN_HEADER = "x-diffdash-core-token"

/** Maximum native MessagePack input retained while waiting for a complete RPC frame. */
export const CORE_RPC_INCOMPLETE_BUFFER_BYTES = 512 * 1_024

/** Electron-to-Core control declarations projected through transport authentication. */
export const AuthenticatedCoreControlRpcs = CoreControlRpcs.middleware(
  CoreTransportAuthenticationMiddleware,
)

/** Electron-to-Core business declarations projected through transport authentication. */
export const AuthenticatedCoreBusinessRpcs = CoreBusinessRpcs.middleware(
  CoreTransportAuthenticationMiddleware,
)

const AuthenticatedAppStateBusinessRpcs = AppStateBusinessRpcs.middleware(
  CoreTransportAuthenticationMiddleware,
)

/** Authenticated server group for methods backed by concrete handlers in the current Core. */
export const AuthenticatedCoreServerRpcs = AuthenticatedCoreControlRpcs.merge(
  AuthenticatedAppStateBusinessRpcs,
)
