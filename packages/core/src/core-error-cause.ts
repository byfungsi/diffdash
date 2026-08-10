import { Schema } from "effect"
export { toCoreExpectedCause } from "./core-defect-boundary"

/** A dependency failure retained by a Core expected-error value. */
export const CoreExpectedCause = Schema.instanceOf(Error)

/** A dependency failure retained by a Core expected-error value. */
export type CoreExpectedCause = Error
