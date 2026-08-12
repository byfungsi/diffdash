import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware"

import { AppStateGetAdmissionFailure } from "./failure"

/** Server-side admission boundary for `AppState.get`. */
export class AppStateGetAdmissionMiddleware extends RpcMiddleware.Service<AppStateGetAdmissionMiddleware>()(
  "@diffdash/core-rpc/AppStateGetAdmissionMiddleware",
  { error: AppStateGetAdmissionFailure },
) {}
