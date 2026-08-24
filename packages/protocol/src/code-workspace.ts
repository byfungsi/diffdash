import {
  CodeWorkspaceDirectoryPage,
  CodeWorkspaceChangesResult,
  CodeWorkspaceFileReadResult,
  CodeWorkspaceLease,
  CodeWorkspaceLeaseId,
  CodeWorkspaceLineChangesResult,
  CodeWorkspaceSearchResult,
  CodeWorkspaceTarget,
} from "@diffdash/domain/code-workspace"
import { LanguagePosition, RepositoryLanguageLocationResult } from "@diffdash/domain/language"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { Schema } from "effect"

const DirectoryOffset = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const DirectoryPageSize = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
)
const SearchResultLimit = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
)

/** Request to materialize one exact managed Code workspace. */
export const OpenCodeWorkspaceRequest = Schema.Struct({ target: CodeWorkspaceTarget })

/** Request to materialize one exact managed Code workspace. */
export type OpenCodeWorkspaceRequest = typeof OpenCodeWorkspaceRequest.Type

/** Request carrying authority for one managed Code workspace. */
export const CodeWorkspaceLeaseRequest = Schema.Struct({ leaseId: CodeWorkspaceLeaseId })

/** Request carrying authority for one managed Code workspace. */
export type CodeWorkspaceLeaseRequest = typeof CodeWorkspaceLeaseRequest.Type

/** Request for one bounded page of immediate managed-checkout children. */
export const ListCodeWorkspaceDirectoryRequest = Schema.Struct({
  leaseId: CodeWorkspaceLeaseId,
  path: Schema.NullOr(RepositoryRelativePath),
  offset: DirectoryOffset,
  limit: DirectoryPageSize,
})

/** Request for one bounded page of immediate managed-checkout children. */
export type ListCodeWorkspaceDirectoryRequest = typeof ListCodeWorkspaceDirectoryRequest.Type

/** Request for bounded filename matches from one managed Code workspace. */
export const SearchCodeWorkspaceRequest = Schema.Struct({
  leaseId: CodeWorkspaceLeaseId,
  query: Schema.String.pipe(Schema.check(Schema.isMaxLength(1_000))),
  offset: DirectoryOffset,
  limit: SearchResultLimit,
})

/** Request for bounded filename matches from one managed Code workspace. */
export type SearchCodeWorkspaceRequest = typeof SearchCodeWorkspaceRequest.Type

/** Request to read one repository-relative managed-checkout file. */
export const ReadCodeWorkspaceFileRequest = Schema.Struct({
  leaseId: CodeWorkspaceLeaseId,
  path: RepositoryRelativePath,
})

/** Request to read one repository-relative managed-checkout file. */
export type ReadCodeWorkspaceFileRequest = typeof ReadCodeWorkspaceFileRequest.Type

/** Request for compact current-side changed-line ranges in one workspace file. */
export const CodeWorkspaceLineChangesRequest = Schema.Struct({
  leaseId: CodeWorkspaceLeaseId,
  path: RepositoryRelativePath,
})

/** Request for compact current-side changed-line ranges in one workspace file. */
export type CodeWorkspaceLineChangesRequest = typeof CodeWorkspaceLineChangesRequest.Type

/** Request for definitions at one source position in a managed Code workspace. */
export const CodeWorkspaceDefinitionsRequest = Schema.Struct({
  leaseId: CodeWorkspaceLeaseId,
  path: RepositoryRelativePath,
  position: LanguagePosition,
})

/** Request for definitions at one source position in a managed Code workspace. */
export type CodeWorkspaceDefinitionsRequest = typeof CodeWorkspaceDefinitionsRequest.Type

/** Request for references at one source position in a managed Code workspace. */
export const CodeWorkspaceReferencesRequest = Schema.Struct({
  leaseId: CodeWorkspaceLeaseId,
  path: RepositoryRelativePath,
  position: LanguagePosition,
})

/** Request for references at one source position in a managed Code workspace. */
export type CodeWorkspaceReferencesRequest = typeof CodeWorkspaceReferencesRequest.Type

export {
  CodeWorkspaceDirectoryPage,
  CodeWorkspaceChangesResult,
  CodeWorkspaceFileReadResult,
  CodeWorkspaceLease,
  CodeWorkspaceLineChangesResult,
  CodeWorkspaceSearchResult,
  RepositoryLanguageLocationResult,
}
