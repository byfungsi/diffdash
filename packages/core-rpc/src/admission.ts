import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware"

import { AppStateGetAdmissionFailure, CoreTransportAuthenticationFailure } from "./failure"

/** Server-side authentication boundary shared by all Electron-to-Core RPCs. */
export class CoreTransportAuthenticationMiddleware extends RpcMiddleware.Service<CoreTransportAuthenticationMiddleware>()(
  "@diffdash/core-rpc/CoreTransportAuthenticationMiddleware",
  { error: CoreTransportAuthenticationFailure },
) {}

/** Server-side admission boundary for `AppState.get`. */
export class AppStateGetAdmissionMiddleware extends RpcMiddleware.Service<AppStateGetAdmissionMiddleware>()(
  "@diffdash/core-rpc/AppStateGetAdmissionMiddleware",
  { error: AppStateGetAdmissionFailure },
) {}
