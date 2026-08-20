import {
  LocalCheckoutFileListResult,
  LocalCheckoutFileReadResult,
} from "@diffdash/domain/local-checkout-file"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { ReviewProjectId } from "@diffdash/domain/review-identity"
import { Schema } from "effect"

/** Request to list source files for a persisted local checkout. */
export const ListLocalCheckoutFilesRequest = Schema.Struct({ projectId: ReviewProjectId })

/** Request to list source files for a persisted local checkout. */
export type ListLocalCheckoutFilesRequest = typeof ListLocalCheckoutFilesRequest.Type

/** Request to read one repository-relative source file from a persisted local checkout. */
export const ReadLocalCheckoutFileRequest = Schema.Struct({
  projectId: ReviewProjectId,
  path: RepositoryRelativePath,
})

/** Request to read one repository-relative source file from a persisted local checkout. */
export type ReadLocalCheckoutFileRequest = typeof ReadLocalCheckoutFileRequest.Type

export { LocalCheckoutFileListResult, LocalCheckoutFileReadResult }
