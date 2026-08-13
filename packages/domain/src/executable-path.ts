import { Schema } from "effect"

/** Absolute path to one executable discovered or installed by DiffDash. */
export const ExecutablePath = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("ExecutablePath"),
)

/** Absolute path to one executable discovered or installed by DiffDash. */
export type ExecutablePath = typeof ExecutablePath.Type
