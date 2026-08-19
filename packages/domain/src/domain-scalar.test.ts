import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { FastCheck } from "effect/testing"

import {
  NonNegativeFiniteNumber,
  NonNegativeInteger,
  PositiveInteger,
  UtcIsoTimestamp,
} from "./domain-scalar"

const rejects = (schema: Schema.ConstraintDecoder<unknown>, values: ReadonlyArray<unknown>) => {
  for (const value of values) {
    expect(Result.isFailure(Schema.decodeUnknownResult(schema)(value))).toBe(true)
  }
}

describe("domain scalar schemas", () => {
  it("rejects invalid counts, ordinals, and finite amounts", () => {
    expect(Schema.encodeSync(NonNegativeInteger)(0)).toBe(0)
    expect(Schema.encodeSync(PositiveInteger)(1)).toBe(1)
    expect(Schema.encodeSync(NonNegativeFiniteNumber)(0.25)).toBe(0.25)

    expect(() => {
      rejects(NonNegativeInteger, [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])
      rejects(PositiveInteger, [0, -1, 1.5, Number.NEGATIVE_INFINITY])
      rejects(NonNegativeFiniteNumber, [-0.01, Number.NaN, Number.POSITIVE_INFINITY])
    }).not.toThrow()
  })

  it("retains valid UTC ISO timestamps as strings", () => {
    const timestamps = ["2026-08-10T00:00:00Z", "2026-08-10T00:00:00.123Z"]

    for (const timestamp of timestamps) {
      expect(Schema.decodeUnknownSync(UtcIsoTimestamp)(timestamp)).toBe(timestamp)
      expect(Schema.encodeSync(UtcIsoTimestamp)(timestamp)).toBe(timestamp)
    }

    rejects(UtcIsoTimestamp, [
      "2026-08-10T00:00:00",
      "2026-08-10T00:00:00+00:00",
      "2026-08-10T00:00:00.1234567890Z",
      "2026-02-30T00:00:00Z",
      "not-a-date",
    ])
  })

  it("derives valid numeric examples from the owning schemas", () => {
    expect(() => {
      FastCheck.assert(
        FastCheck.property(
          Schema.toArbitrary(NonNegativeInteger),
          (value) => Number.isSafeInteger(value) && value >= 0,
        ),
      )
      FastCheck.assert(
        FastCheck.property(
          Schema.toArbitrary(PositiveInteger),
          (value) => Number.isSafeInteger(value) && value > 0,
        ),
      )
      FastCheck.assert(
        FastCheck.property(
          Schema.toArbitrary(NonNegativeFiniteNumber),
          (value) => Number.isFinite(value) && value >= 0,
        ),
      )
    }).not.toThrow()
  })
})
