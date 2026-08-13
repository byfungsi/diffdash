import { CoreTransportAuthenticationMiddleware } from "./admission"
import { CoreBusinessRpcs } from "./business"
import { CoreControlRpcs } from "./control"

/** Private native RPC header carrying the one-time Core transport credential. */
export const CORE_TRANSPORT_TOKEN_HEADER = "x-diffdash-core-token"

/** Maximum native MessagePack input retained while waiting for a complete RPC frame. */
export const CORE_RPC_INCOMPLETE_BUFFER_BYTES = 64 * 1_024

/** Electron-to-Core control declarations projected through transport authentication. */
export const AuthenticatedCoreControlRpcs = CoreControlRpcs.middleware(
  CoreTransportAuthenticationMiddleware,
)

/** Electron-to-Core business declarations projected through transport authentication. */
export const AuthenticatedCoreBusinessRpcs = CoreBusinessRpcs.middleware(
  CoreTransportAuthenticationMiddleware,
)

/** Complete authenticated Electron-to-Core transport group. */
export const AuthenticatedCoreServerRpcs = AuthenticatedCoreControlRpcs.merge(
  AuthenticatedCoreBusinessRpcs,
)
