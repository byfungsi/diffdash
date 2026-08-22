import { CoreMethod } from "@diffdash/core"
import type { ApplicationRuntime } from "../../application-runtime"
import { IpcControllerRegistry } from "./controller-registry"

/** Defines renderer operations for OpenCode session discovery and comment forwarding. */
export const defineAIHandlers = (runtime: ApplicationRuntime, handlers: IpcControllerRegistry) => {
  handlers.defineCore(CoreMethod.listOpenCodeSessions, runtime.core.listOpenCodeSessions)
  handlers.defineCore(CoreMethod.connectOpenCodeSession, runtime.core.connectOpenCodeSession)
  handlers.defineCore(CoreMethod.submitComment, runtime.core.submitComment)
}
