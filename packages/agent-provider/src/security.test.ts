import { describe, expect, it } from "@effect/vitest"

import {
  isScopedMcpToolSubset,
  redactProviderSecrets,
  sanitizeProviderDiagnostic,
} from "./security"

describe("agent provider security", () => {
  it("validates scoped MCP tools as a subset of policy tools", () => {
    expect(isScopedMcpToolSubset(["read", "search"], ["search", "read", "context"])).toBe(true)
    expect(isScopedMcpToolSubset(["read", "publish"], ["read", "search"])).toBe(false)
  })

  it("redacts the shared credential corpus without changing surrounding formatting", () => {
    const corpus = [
      ["Authorization: Bearer authorization-secret, next", "Authorization: [redacted], next"],
      ["Authorization=Basic basic-secret; next", "Authorization=[redacted]; next"],
      [
        '{"headers":{"Authorization":"Bearer json-secret"},"ok":true}',
        '{"headers":{"Authorization":"[redacted]"},"ok":true}',
      ],
      ["bEaReR standalone-secret, next", "bEaReR [redacted], next"],
      ["DIFFDASH_MCP_BEARER_TOKEN=diffdash-secret", "DIFFDASH_MCP_BEARER_TOKEN=[redacted]"],
      ['access_token: "access-secret"', 'access_token: "[redacted]"'],
      ["AuthToken='auth-secret'", "AuthToken='[redacted]'"],
      ["refresh-token=refresh-secret", "refresh-token=[redacted]"],
      ['"ID_TOKEN": "id-secret"', '"ID_TOKEN": "[redacted]"'],
      ["api-key=api-secret", "api-key=[redacted]"],
      ["OPENAI_API_KEY=provider-api-secret", "OPENAI_API_KEY=[redacted]"],
      ["GITHUB_TOKEN=provider-token-secret", "GITHUB_TOKEN=[redacted]"],
      ["MiXeD_AcCeSs-ToKeN=mixed-secret", "MiXeD_AcCeSs-ToKeN=[redacted]"],
    ] as const

    for (const [input, expected] of corpus) expect(redactProviderSecrets(input)).toBe(expected)

    const multiline = `first line
Authorization: Bearer line-secret
last line`
    expect(redactProviderSecrets(multiline)).toBe(`first line
Authorization: [redacted]
last line`)
  })

  it("normalizes redacted diagnostics to one line", () => {
    expect(
      sanitizeProviderDiagnostic(`
        Authorization: Bearer authorization-secret
        access_token: "access-secret"
        token='common-secret'
      `),
    ).toBe("Authorization: [redacted] access_token: \"[redacted]\" token='[redacted]'")
  })

  it("keeps baseline sanitization authoritative around provider-specific hooks", () => {
    expect(
      sanitizeProviderDiagnostic("vendor-secret Bearer shared-secret", (value) =>
        value.replace("vendor-secret", "[vendor-redacted]"),
      ),
    ).toBe("[vendor-redacted] Bearer [redacted]")
    expect(
      sanitizeProviderDiagnostic("Bearer shared-secret", () => {
        throw new Error("broken provider redactor")
      }),
    ).toBe("Bearer [redacted]")
  })
})
