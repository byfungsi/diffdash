import { Schema } from "effect"

import { RepositoryRelativePath } from "./repository-path"

/** Maximum source-file bytes returned through the renderer bridge. */
export const LOCAL_CHECKOUT_FILE_MAX_BYTES = 256 * 1_024

/** Maximum aggregate Git filename bytes accepted from one checkout listing. */
export const LOCAL_CHECKOUT_FILE_LIST_MAX_BYTES = 384 * 1_024

/** Maximum files returned by one checkout listing. */
export const LOCAL_CHECKOUT_FILE_LIST_MAX_ENTRIES = 10_000

/** Recoverable reason a checkout file list could not be produced. */
export const LocalCheckoutFileListRejectionReason = Schema.Literals([
  "checkoutUnavailable",
  "gitUnavailable",
  "invalidPath",
  "limitExceeded",
  "repositoryNotFound",
  "repositoryUnavailable",
])

/** Recoverable reason a checkout file list could not be produced. */
export type LocalCheckoutFileListRejectionReason = typeof LocalCheckoutFileListRejectionReason.Type

/** Result of listing tracked and non-ignored untracked files in a local checkout. */
export const LocalCheckoutFileListResult = Schema.TaggedUnion({
  files: {
    paths: Schema.Array(RepositoryRelativePath).pipe(
      Schema.check(Schema.isMaxLength(LOCAL_CHECKOUT_FILE_LIST_MAX_ENTRIES)),
    ),
  },
  rejected: { reason: LocalCheckoutFileListRejectionReason },
})

/** Result of listing tracked and non-ignored untracked files in a local checkout. */
export type LocalCheckoutFileListResult = typeof LocalCheckoutFileListResult.Type

/** A deterministic list of readable checkout candidates. */
export const LocalCheckoutFileList = LocalCheckoutFileListResult.cases.files

/** A deterministic list of readable checkout candidates. */
export type LocalCheckoutFileList = typeof LocalCheckoutFileList.Type

/** Recoverable checkout listing rejection without machine-local path disclosure. */
export const LocalCheckoutFileListRejected = LocalCheckoutFileListResult.cases.rejected

/** Recoverable checkout listing rejection without machine-local path disclosure. */
export type LocalCheckoutFileListRejected = typeof LocalCheckoutFileListRejected.Type

/** Recoverable reason a checkout file was not returned. */
export const LocalCheckoutFileReadRejectionReason = Schema.Literals([
  "binary",
  "checkoutUnavailable",
  "invalidUtf8",
  "ioFailure",
  "missing",
  "notRegularFile",
  "oversized",
  "repositoryNotFound",
  "repositoryUnavailable",
  "unsafeSymlink",
])

/** Recoverable reason a checkout file was not returned. */
export type LocalCheckoutFileReadRejectionReason = typeof LocalCheckoutFileReadRejectionReason.Type

/** Result of reading one repository-relative path from a local checkout. */
export const LocalCheckoutFileReadResult = Schema.TaggedUnion({
  content: {
    path: RepositoryRelativePath,
    content: Schema.String,
  },
  rejected: {
    path: RepositoryRelativePath,
    reason: LocalCheckoutFileReadRejectionReason,
  },
})

/** Result of reading one repository-relative path from a local checkout. */
export type LocalCheckoutFileReadResult = typeof LocalCheckoutFileReadResult.Type

/** UTF-8 text read from one repository-relative checkout path. */
export const LocalCheckoutFileContent = LocalCheckoutFileReadResult.cases.content

/** UTF-8 text read from one repository-relative checkout path. */
export type LocalCheckoutFileContent = typeof LocalCheckoutFileContent.Type

/** Recoverable checkout file rejection without machine-local path disclosure. */
export const LocalCheckoutFileReadRejected = LocalCheckoutFileReadResult.cases.rejected

/** Recoverable checkout file rejection without machine-local path disclosure. */
export type LocalCheckoutFileReadRejected = typeof LocalCheckoutFileReadRejected.Type
