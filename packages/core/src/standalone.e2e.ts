import { runStandaloneCoreProcess } from "./standalone-process"

runStandaloneCoreProcess()

export { createE2EEmbeddedCore as createStandaloneCore } from "./e2e"
export { coreLifecycleLayer } from "./core-lifecycle"
export { coreRpcSocketHostLayer } from "./core-rpc-socket-host"
