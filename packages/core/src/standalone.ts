import { runStandaloneCoreProcess } from "./standalone-process"

runStandaloneCoreProcess()

export { createEmbeddedCore as createStandaloneCore } from "./embedded-core"
export { coreLifecycleLayer } from "./core-lifecycle"
export {
  coreRpcSocketHostLayer,
  coreWalkthroughRpcSocketHostLayer,
} from "./core-rpc-socket-host"
