import { Schema } from "effect"

/** A safe integer count, size, index, or sequence that may be zero. */
export const NonNegativeInteger = Schema.Natural

/** A safe integer ordinal or identifier component that must be greater than zero. */
export const PositiveInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))

/** A finite numeric amount that may be zero but cannot be negative. */
export const NonNegativeFiniteNumber = Schema.Finite.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
)

const utcIsoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u

const isUtcIsoTimestamp = (value: string) => {
  if (!utcIsoPattern.test(value)) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19)
}

/** A valid ISO 8601 UTC timestamp retained as its original string representation. */
export const UtcIsoTimestamp = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(isUtcIsoTimestamp, { message: "Expected a valid UTC ISO timestamp" }),
  ),
)
