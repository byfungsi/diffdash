import { Schema } from "effect"

import { NonNegativeInteger } from "./domain-scalar"
import { RepositoryRelativePath } from "./repository-path"

/** Stable identifier for one language adapter family. */
export const LanguageAdapterId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.brand("LanguageAdapterId"),
)

/** Stable identifier for one language adapter family. */
export type LanguageAdapterId = typeof LanguageAdapterId.Type

/** Stable identifier for one source language. */
export const LanguageId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100)),
  Schema.brand("LanguageId"),
)

/** Stable identifier for one source language. */
export type LanguageId = typeof LanguageId.Type

/** Zero-based UTF-16 source position. */
export class LanguagePosition extends Schema.Class<LanguagePosition>("LanguagePosition")({
  line: NonNegativeInteger,
  character: NonNegativeInteger,
}) {}

/** Half-open source range expressed in zero-based UTF-16 positions. */
export class LanguageRange extends Schema.Class<LanguageRange>("LanguageRange")({
  start: LanguagePosition,
  end: LanguagePosition,
}) {}

/** Provider-neutral symbol categories supported by Code navigation. */
export const LanguageSymbolKind = Schema.Literals([
  "array",
  "boolean",
  "class",
  "constant",
  "constructor",
  "enum",
  "enumMember",
  "event",
  "field",
  "file",
  "function",
  "interface",
  "key",
  "method",
  "module",
  "namespace",
  "null",
  "number",
  "object",
  "operator",
  "package",
  "property",
  "string",
  "struct",
  "typeParameter",
  "variable",
])

/** Provider-neutral symbol category supported by Code navigation. */
export type LanguageSymbolKind = typeof LanguageSymbolKind.Type

/** Repository-contained source location safe to expose outside Core. */
export class RepositoryLanguageLocation extends Schema.Class<RepositoryLanguageLocation>(
  "RepositoryLanguageLocation",
)({
  path: RepositoryRelativePath,
  range: LanguageRange,
}) {}

/** Definition location with an optional source range supplied by the adapter. */
export class RepositoryLanguageLocationLink extends Schema.Class<RepositoryLanguageLocationLink>(
  "RepositoryLanguageLocationLink",
)({
  originSelectionRange: Schema.OptionFromNullOr(LanguageRange),
  target: RepositoryLanguageLocation,
  targetSelectionRange: LanguageRange,
}) {}

/** One symbol in the current source document. */
export class DocumentLanguageSymbol extends Schema.Class<DocumentLanguageSymbol>(
  "DocumentLanguageSymbol",
)({
  name: Schema.String.pipe(Schema.check(Schema.isMaxLength(500))),
  detail: Schema.OptionFromNullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(1_000)))),
  kind: LanguageSymbolKind,
  range: LanguageRange,
  selectionRange: LanguageRange,
  containerName: Schema.OptionFromNullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))),
}) {}

/** One repository-contained symbol returned by workspace search. */
export class WorkspaceLanguageSymbol extends Schema.Class<WorkspaceLanguageSymbol>(
  "WorkspaceLanguageSymbol",
)({
  name: Schema.String.pipe(Schema.check(Schema.isMaxLength(500))),
  kind: LanguageSymbolKind,
  containerName: Schema.OptionFromNullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))),
  location: RepositoryLanguageLocation,
}) {}

/** Bounded current-document symbol response. */
export class DocumentLanguageSymbolResult extends Schema.Class<DocumentLanguageSymbolResult>(
  "DocumentLanguageSymbolResult",
)({
  symbols: Schema.Array(DocumentLanguageSymbol).pipe(Schema.check(Schema.isMaxLength(1_000))),
  truncated: Schema.Boolean,
}) {}

/** Bounded workspace symbol response. */
export class WorkspaceLanguageSymbolResult extends Schema.Class<WorkspaceLanguageSymbolResult>(
  "WorkspaceLanguageSymbolResult",
)({
  symbols: Schema.Array(WorkspaceLanguageSymbol).pipe(Schema.check(Schema.isMaxLength(100))),
  truncated: Schema.Boolean,
}) {}

/** Bounded repository location response used for definitions and references. */
export class RepositoryLanguageLocationResult extends Schema.Class<RepositoryLanguageLocationResult>(
  "RepositoryLanguageLocationResult",
)({
  locations: Schema.Array(RepositoryLanguageLocationLink).pipe(
    Schema.check(Schema.isMaxLength(100)),
  ),
  truncated: Schema.Boolean,
}) {}

/** Recoverable reason a language operation could not complete. */
export const LanguageOperationFailureReason = Schema.Literals([
  "malformedResponse",
  "resultTooLarge",
  "serverFailed",
  "serverUnavailable",
  "timeout",
  "unsafeLocation",
  "unsupportedCapability",
  "unsupportedLanguage",
])

/** Recoverable reason a language operation could not complete. */
export type LanguageOperationFailureReason = typeof LanguageOperationFailureReason.Type

/** Renderer-safe expected language operation failure. */
export class LanguageOperationError extends Schema.TaggedError<LanguageOperationError>()(
  "LanguageOperationError",
  {
    operation: Schema.String,
    reason: LanguageOperationFailureReason,
    message: Schema.String,
  },
) {}
