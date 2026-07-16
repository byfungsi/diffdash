import { Schema } from "effect"
import { HostedRepositoryLocator } from "@diffdash/domain/git-provider"

/** Renderer request to link one expected hosted repository to a local checkout. */
export class LinkRepositoryCheckoutRequest extends Schema.Class<LinkRepositoryCheckoutRequest>(
  "LinkRepositoryCheckoutRequest",
)({
  repository: HostedRepositoryLocator,
  localPath: Schema.String.pipe(Schema.minLength(1)),
}) {}
