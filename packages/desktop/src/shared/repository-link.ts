import { Schema } from "effect"

/** Renderer request to link one expected GitHub repository to a local checkout. */
export class LinkRepositoryCheckoutRequest extends Schema.Class<LinkRepositoryCheckoutRequest>(
  "LinkRepositoryCheckoutRequest",
)({
  owner: Schema.String.pipe(Schema.minLength(1)),
  name: Schema.String.pipe(Schema.minLength(1)),
  localPath: Schema.String.pipe(Schema.minLength(1)),
}) {}
