import { CoreConfigurationError } from "@diffdash/core"
import { Schema } from "effect"

import { CoreArtifactVerificationError } from "./core-artifact"
import { CoreHostSelectionError } from "./core-host-selection"

/** Expected failure while waiting for the authorized Core runtime to finish recovery. */
export class CoreStartupReadinessError extends Schema.TaggedError<CoreStartupReadinessError>()(
  "CoreStartupReadinessError",
  { reason: Schema.Literals(["failed", "draining", "timeout"]) },
) {}

/** Reports allowlisted startup reasons without exposing raw defects, credentials, or private paths. */
export const formatDesktopStartupError = <Failure>(error: Failure): string => {
  if (Schema.is(CoreHostSelectionError)(error)) {
    return `${error.safeMessage} [${error._tag}: mode=${error.mode}, host=${error.host ?? "none"}, reason=${error.reason}, capability=${error.qualificationCapability ?? "none"}]`
  }
  if (Schema.is(CoreArtifactVerificationError)(error)) {
    return `${error.safeMessage} [${error._tag}: ${error.reason}]`
  }
  if (Schema.is(CoreStartupReadinessError)(error)) {
    return `DiffDash Core could not finish starting. [${error._tag}: ${error.reason}]`
  }
  if (Schema.is(CoreConfigurationError)(error)) {
    return "DiffDash Core configuration is invalid. [CoreConfigurationError]"
  }
  return "DiffDash could not finish starting. Please report this startup error."
}
