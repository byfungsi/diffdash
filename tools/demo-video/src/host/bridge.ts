import {
  CodeWorkspaceLease,
  RepositoryLanguageLocationResult,
} from "@diffdash/protocol/code-workspace"
import { Schema } from "effect"

/** Encodes demo runtime values into the transport representation expected by the renderer. */
export const encodeDemoBridgeValue = <Value>(
  path: string,
  value: Value,
):
  | Value
  | null
  | typeof CodeWorkspaceLease.Encoded
  | typeof RepositoryLanguageLocationResult.Encoded => {
  if (value === undefined) return null
  if (
    (path === "codeWorkspace.open" || path === "codeWorkspace.heartbeat") &&
    Schema.is(CodeWorkspaceLease)(value)
  ) {
    return Schema.encodeSync(CodeWorkspaceLease)(value)
  }
  if (
    (path === "codeWorkspace.definitions" || path === "codeWorkspace.references") &&
    Schema.is(RepositoryLanguageLocationResult)(value)
  ) {
    return Schema.encodeSync(RepositoryLanguageLocationResult)(value)
  }
  return value
}
