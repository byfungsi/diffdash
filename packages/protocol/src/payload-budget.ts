import { Predicate, Schema } from "effect"
import { utf8ByteLength } from "@diffdash/domain/utf8"
import { TransportError, transportError } from "./transport-error"

type JsonPayloadValue = Schema.Json | object | bigint | symbol | undefined

/** Default structural limits applied before JSON serialization at IPC boundaries. */
export const DEFAULT_PAYLOAD_STRUCTURE_LIMITS = {
  maxDepth: 64,
  maxNodes: 100_000,
} as const

/** Structural work bounds for JSON-safe payload sizing. */
export interface PayloadStructureLimits {
  readonly maxDepth: number
  readonly maxNodes: number
}

/** Returns bounded encoded bytes for a JSON-safe payload with structured-clone binary leaves. */
export const jsonSafeUtf8ByteLength = <Value extends JsonPayloadValue>(
  value: Value,
  limits: PayloadStructureLimits = DEFAULT_PAYLOAD_STRUCTURE_LIMITS,
): number => {
  validatePositiveSafeInteger(limits.maxDepth, "maxDepth")
  validatePositiveSafeInteger(limits.maxNodes, "maxNodes")

  const pending: Array<{ readonly value: JsonPayloadValue; readonly depth: number }> = [
    { value, depth: 0 },
  ]
  const seen = new WeakSet()
  let binaryBytes = 0
  let nodes = 0

  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    nodes += 1
    if (nodes > limits.maxNodes || current.depth > limits.maxDepth) {
      throw transportError("PAYLOAD_TOO_LARGE", "IPC payload exceeds its structural size limit.")
    }

    const item = current.value
    if (item === null || Predicate.isString(item) || Predicate.isBoolean(item)) continue
    if (Predicate.isNumber(item)) {
      if (!Number.isFinite(item)) {
        throw transportError("INVALID_PAYLOAD", "IPC payload must contain finite numbers.")
      }
      continue
    }
    if (!Predicate.isObjectOrArray(item)) {
      throw transportError("INVALID_PAYLOAD", "IPC payload must be JSON-safe.")
    }
    if (item instanceof Uint8Array) {
      binaryBytes += item.byteLength
      continue
    }
    if (seen.has(item)) {
      throw transportError("INVALID_PAYLOAD", "IPC payload must not contain cycles.")
    }
    seen.add(item)

    if (!Array.isArray(item)) {
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) {
        throw transportError("INVALID_PAYLOAD", "IPC payload must contain plain objects.")
      }
    }
    const children = Array.isArray(item) ? item : Object.values(item)
    for (const child of children) {
      if (
        child === null ||
        child === undefined ||
        Predicate.isString(child) ||
        Predicate.isBoolean(child) ||
        Predicate.isNumber(child) ||
        Predicate.isBigInt(child) ||
        Predicate.isSymbol(child) ||
        Predicate.isObjectOrArray(child) ||
        Predicate.isFunction(child)
      ) {
        pending.push({ value: child, depth: current.depth + 1 })
      }
    }
  }

  let serialized: string
  try {
    const result = JSON.stringify(value, (_key, item: JsonPayloadValue) =>
      item instanceof Uint8Array ? null : item,
    )
    if (result === undefined) {
      throw transportError("INVALID_PAYLOAD", "IPC payload must be JSON-safe.")
    }
    serialized = result
  } catch (error) {
    if (Schema.is(TransportError)(error)) throw error
    throw transportError("INVALID_PAYLOAD", "IPC payload could not be serialized safely.")
  }
  return utf8ByteLength(serialized) + binaryBytes
}

/** Rejects a JSON-safe payload whose aggregate UTF-8 representation exceeds the byte budget. */
export const assertJsonPayloadWithinBudget = <Value extends JsonPayloadValue>(
  value: Value,
  maxBytes: number,
  operation?: string,
): number => {
  validatePositiveSafeInteger(maxBytes, "maxBytes")
  const bytes = jsonSafeUtf8ByteLength(value)
  if (bytes > maxBytes) {
    throw transportError(
      "PAYLOAD_TOO_LARGE",
      `IPC payload exceeds the ${maxBytes}-byte limit.`,
      operation,
    )
  }
  return bytes
}

const validatePositiveSafeInteger = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
}
