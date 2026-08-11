import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

/** Core-to-Electron host-capability declarations; capabilities are added only with real callers. */
export const CoreHostCapabilityRpcs = RpcGroup.make()
