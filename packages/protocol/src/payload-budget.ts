import { TransportError, transportError } from "./transport-error"

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

/** Returns the exact UTF-8 bytes of a bounded JSON-safe payload. */
export const jsonSafeUtf8ByteLength = (
  value: unknown,
  limits: PayloadStructureLimits = DEFAULT_PAYLOAD_STRUCTURE_LIMITS,
): number => {
  validatePositiveSafeInteger(limits.maxDepth, "maxDepth")
  validatePositiveSafeInteger(limits.maxNodes, "maxNodes")

  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }]
  const seen = new WeakSet<object>()
  let nodes = 0

  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    nodes += 1
    if (nodes > limits.maxNodes || current.depth > limits.maxDepth) {
      throw transportError("PAYLOAD_TOO_LARGE", "IPC payload exceeds its structural size limit.")
    }

    const item = current.value
    if (item === null || typeof item === "string" || typeof item === "boolean") continue
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw transportError("INVALID_PAYLOAD", "IPC payload must contain finite numbers.")
      }
      continue
    }
    if (typeof item !== "object") {
      throw transportError("INVALID_PAYLOAD", "IPC payload must be JSON-safe.")
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
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 })
  }

  let serialized: string
  try {
    const result = JSON.stringify(value)
    if (result === undefined) {
      throw transportError("INVALID_PAYLOAD", "IPC payload must be JSON-safe.")
    }
    serialized = result
  } catch (error) {
    if (error instanceof TransportError) throw error
    throw transportError("INVALID_PAYLOAD", "IPC payload could not be serialized safely.")
  }
  return new TextEncoder().encode(serialized).byteLength
}

/** Rejects a JSON-safe payload whose aggregate UTF-8 representation exceeds the byte budget. */
export const assertJsonPayloadWithinBudget = (
  value: unknown,
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
