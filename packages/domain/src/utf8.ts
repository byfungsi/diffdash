const normalizedByteBudget = (maxBytes: number) =>
  Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0

/** Returns the number of bytes required to encode a string as UTF-8. */
export const utf8ByteLength = (value: string) => new TextEncoder().encode(value).byteLength

/** Returns the longest leading substring that fits without splitting a Unicode code point. */
export const utf8Prefix = (value: string, maxBytes: number) => {
  const budget = normalizedByteBudget(maxBytes)
  if (budget === 0) return ""

  let bytes = 0
  let end = 0
  for (const character of value) {
    const characterBytes = utf8ByteLength(character)
    if (bytes + characterBytes > budget) break
    bytes += characterBytes
    end += character.length
  }
  return value.slice(0, end)
}

/** Truncates UTF-8 text and appends a complete marker when it fits. */
export const truncateUtf8 = (value: string, maxBytes: number, marker = "") => {
  const budget = normalizedByteBudget(maxBytes)
  if (utf8ByteLength(value) <= budget) return value
  if (budget === 0) return ""

  const markerBytes = utf8ByteLength(marker)
  if (markerBytes > budget) return utf8Prefix(value, budget)
  return `${utf8Prefix(value, budget - markerBytes)}${marker}`
}
