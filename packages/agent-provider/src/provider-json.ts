import { Effect, Predicate, Schema } from "effect"

const circularProviderJsonValue = "[Circular]"
const unserializableProviderJsonValue = "[Unserializable]"

/** Provider JSONL was invalid JSON or did not contain an object event. */
export class ProviderJsonlObjectParseError extends Schema.TaggedError<ProviderJsonlObjectParseError>()(
  "ProviderJsonlObjectParseError",
  { reason: Schema.String },
) {}

/** Parses one JSONL line and rejects valid JSON values that are not object events. */
export const parseProviderJsonlObject = (
  line: string,
): Effect.Effect<Readonly<Record<string, unknown>>, ProviderJsonlObjectParseError> =>
  Effect.try({
    try: () => JSON.parse(line) as unknown,
    catch: (cause) =>
      ProviderJsonlObjectParseError.make({
        reason: cause instanceof Error ? cause.message : "invalid JSON",
      }),
  }).pipe(
    Effect.flatMap((value) =>
      Predicate.isReadonlyRecord(value)
        ? Effect.succeed(value)
        : ProviderJsonlObjectParseError.make({ reason: "event is not a JSON object" }),
    ),
  )

/** Parses plain or fenced provider JSON, preserving non-string values and invalid input. */
export const parseProviderJsonText = (value: unknown): unknown => {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  const json = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")
    : trimmed
  try {
    return JSON.parse(json) as unknown
  } catch {
    return value
  }
}

/** Reads a string property from an unknown-value record. */
export const stringAt = (record: Readonly<Record<string, unknown>>, key: string) =>
  typeof record[key] === "string" ? record[key] : null

/** Reads a finite numeric property from an unknown-value record. */
export const numberAt = (record: Readonly<Record<string, unknown>>, key: string) =>
  typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : null

/** Reads a finite non-negative numeric property from an unknown-value record. */
export const nonNegativeNumberAt = (record: Readonly<Record<string, unknown>>, key: string) => {
  const value = numberAt(record, key)
  return value !== null && value >= 0 ? value : null
}

/** Reads a non-array object property from an unknown-value record. */
export const recordAt = (record: Readonly<Record<string, unknown>>, key: string) => {
  const value = record[key]
  return Predicate.isReadonlyRecord(value) ? value : null
}

/** Reads an array property from an unknown-value record. */
export const arrayAt = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): readonly unknown[] => {
  const value = record[key]
  return Array.isArray(value) ? value : []
}

/** Omits null fields from provider artifact metadata. */
export const providerMetadata = (values: Readonly<Record<string, string | number | null>>) =>
  Object.fromEntries(Object.entries(values).filter((entry) => entry[1] !== null))

/** Serializes unknown provider content without throwing, including cyclic and BigInt values. */
export const providerJsonContent = (value: unknown): string => {
  if (typeof value === "string") return value
  const ancestors: object[] = []
  try {
    const serialized = JSON.stringify(value, function (_key, nestedValue: unknown) {
      if (typeof nestedValue === "bigint") return `${nestedValue.toString()}n`
      if (typeof nestedValue !== "object" || nestedValue === null) return nestedValue
      while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop()
      if (ancestors.includes(nestedValue)) return circularProviderJsonValue
      ancestors.push(nestedValue)
      return nestedValue
    })
    if (serialized !== undefined) return serialized
  } catch {
    return unserializableProviderJsonValue
  }
  if (value === undefined) return "undefined"
  if (typeof value === "function") return "[Function]"
  if (typeof value === "symbol") return "[Symbol]"
  return unserializableProviderJsonValue
}
