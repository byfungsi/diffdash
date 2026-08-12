import { Option, Predicate, Schema } from "effect"

const circularProviderJsonValue = "[Circular]"
const unserializableProviderJsonValue = "[Unserializable]"

const JsonFromString = Schema.fromJsonString(Schema.Json)
type ProviderJsonInput = Schema.Json | bigint | object | undefined | symbol

/** Parses plain or fenced provider JSON, preserving non-string values and invalid input. */
export const parseProviderJsonText = <Input extends ProviderJsonInput>(
  value: Input,
): ProviderJsonInput => {
  if (!Predicate.isString(value)) return value
  const trimmed = value.trim()
  const json = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")
    : trimmed
  return Option.getOrElse(Schema.decodeUnknownOption(JsonFromString)(json), () => value)
}

/** Serializes unknown provider content without throwing, including cyclic and BigInt values. */
export const providerJsonContent = <Input extends ProviderJsonInput>(value: Input): string => {
  if (Predicate.isString(value)) return value
  const ancestors: object[] = []
  try {
    const serialized = JSON.stringify(value, function (_key, nestedValue: unknown) {
      if (Predicate.isBigInt(nestedValue)) return `${nestedValue.toString()}n`
      if (!Predicate.isObjectOrArray(nestedValue)) return nestedValue
      while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop()
      if (ancestors.includes(nestedValue)) return circularProviderJsonValue
      ancestors.push(nestedValue)
      return nestedValue
    })
    if (serialized !== undefined) return serialized
  } catch {
    return unserializableProviderJsonValue
  }
  if (Predicate.isUndefined(value)) return "undefined"
  if (Predicate.isFunction(value)) return "[Function]"
  if (Predicate.isSymbol(value)) return "[Symbol]"
  return unserializableProviderJsonValue
}
