/**
 * Returns a deterministic unsigned 32-bit string hash for stable UI bucketing and DOM IDs.
 * This hash is explicitly non-cryptographic and must not be used for security or data integrity.
 */
export const stableStringHash32 = (value: string) => {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash
}
