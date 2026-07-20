const authorizationAssignment =
  /(["']?\bAuthorization\b["']?(?:[ \t]+header)?[ \t]*[:=][ \t]*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[redacted\]|(?:Bearer|Basic|Token)[ \t]+[^\s,;}\])]+|[^\s,;}\])]+)/giu
const diffDashTokenAssignment =
  /(["']?\bDIFFDASH_MCP_BEARER_TOKEN\b["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[redacted\]|[^\s,;}\])]+)/giu
const commonTokenAssignment =
  /(["']?\b(?:[A-Za-z][A-Za-z0-9_-]*[_-])?(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|refresh[_-]?token|id[_-]?token|token)\b["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[redacted\]|[^\s,;}\])]+)/giu
const bearerCredential =
  /(\bBearer[ \t]+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[redacted\]|[^\s,;}\])]+)/giu

/** Optional provider-owned redaction applied in addition to the mandatory shared baseline. */
export type ProviderDiagnosticExtraRedaction = (value: string) => string

/** Returns whether every scoped MCP tool is present in the execution policy's tool allowlist. */
export const isScopedMcpToolSubset = (
  scopedTools: readonly string[],
  policyTools: readonly string[],
): boolean => scopedTools.every((tool) => policyTools.includes(tool))

/** Redacts recognized provider credentials while preserving surrounding text formatting. */
export const redactProviderSecrets = (value: string): string =>
  value
    .replace(diffDashTokenAssignment, redactCredentialAssignment)
    .replace(commonTokenAssignment, redactCredentialAssignment)
    .replace(authorizationAssignment, redactCredentialAssignment)
    .replace(bearerCredential, redactCredentialAssignment)

/** Applies baseline credential redaction and whitespace normalization to provider diagnostics. */
export const sanitizeProviderDiagnostic = (
  value: string,
  extraRedaction?: ProviderDiagnosticExtraRedaction,
): string => {
  let redacted = value
  if (extraRedaction !== undefined) {
    try {
      redacted = extraRedaction(redacted)
    } catch {
      // A provider hook cannot disable the mandatory shared sanitization path.
    }
  }
  return redactProviderSecrets(redacted).replace(/\s+/gu, " ").trim()
}

const redactCredentialAssignment = (_match: string, prefix: string, credential: string) =>
  `${prefix}${credential.startsWith('"') ? '"[redacted]"' : credential.startsWith("'") ? "'[redacted]'" : "[redacted]"}`
