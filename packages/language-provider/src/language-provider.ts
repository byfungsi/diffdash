import type { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import {
  LanguageAdapterId,
  LanguageId,
  type DocumentLanguageSymbolResult,
  type LanguageOperationError,
  type LanguagePosition,
  type RepositoryLanguageLocationResult,
  type WorkspaceLanguageSymbolResult,
} from "@diffdash/domain/language"
import { Effect, Schema, type Scope } from "effect"

/** Language features independently advertised by an adapter. */
export class LanguageAdapterCapabilities extends Schema.Class<LanguageAdapterCapabilities>(
  "LanguageAdapterCapabilities",
)({
  definitions: Schema.Boolean,
  documentSymbols: Schema.Boolean,
  references: Schema.Boolean,
  workspaceSymbols: Schema.Boolean,
}) {}

/** Provider-neutral identity and file claims for one language adapter family. */
export class LanguageAdapterDescriptor extends Schema.Class<LanguageAdapterDescriptor>(
  "LanguageAdapterDescriptor",
)({
  id: LanguageAdapterId,
  displayName: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  languageIds: Schema.Array(LanguageId).pipe(Schema.check(Schema.isMinLength(1))),
  extensions: Schema.Array(
    Schema.String.pipe(Schema.check(Schema.isPattern(/^\.[a-z0-9][a-z0-9+_-]*$/u))),
  ).pipe(Schema.check(Schema.isMinLength(1))),
  capabilities: LanguageAdapterCapabilities,
}) {}

/** Live lease-scoped language adapter session. */
export interface LanguageAdapterSession {
  readonly documentSymbols: (
    path: RepositoryRelativePath,
  ) => Effect.Effect<DocumentLanguageSymbolResult, LanguageOperationError>
  readonly workspaceSymbols: (
    query: string,
  ) => Effect.Effect<WorkspaceLanguageSymbolResult, LanguageOperationError>
  readonly definitions: (
    path: RepositoryRelativePath,
    position: LanguagePosition,
  ) => Effect.Effect<RepositoryLanguageLocationResult, LanguageOperationError>
  readonly references: (
    path: RepositoryRelativePath,
    position: LanguagePosition,
  ) => Effect.Effect<RepositoryLanguageLocationResult, LanguageOperationError>
}

/** Complete provider-neutral registration supplied by one concrete language adapter. */
export interface LanguageAdapterRegistration {
  readonly descriptor: LanguageAdapterDescriptor
  readonly probe: Effect.Effect<void, LanguageOperationError>
  readonly openSession: (
    root: RepositoryCheckoutPath,
  ) => Effect.Effect<LanguageAdapterSession, LanguageOperationError, Scope.Scope>
}
