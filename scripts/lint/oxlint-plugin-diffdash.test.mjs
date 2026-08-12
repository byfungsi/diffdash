import assert from "node:assert/strict"
import test from "node:test"

import { diffdashLintRules } from "./oxlint-plugin-diffdash.mjs"

const reportsFor = (ruleName, visit, node) => {
  const reports = []
  const visitors = diffdashLintRules[ruleName].create({
    report: (report) => reports.push(report),
    sourceCode: {
      getText: () => "value",
    },
  })
  visitors[visit](node)
  return reports
}

test("no-object-parameters rejects direct, union, and aliased object inputs", () => {
  const reports = []
  const visitors = diffdashLintRules["no-object-parameters"].create({
    report: (report) => reports.push(report),
  })
  visitors.Program({
    type: "Program",
    body: [
      {
        type: "TSTypeAliasDeclaration",
        id: { name: "StructuredValue" },
        typeAnnotation: { type: "TSObjectKeyword" },
        typeParameters: null,
      },
    ],
  })
  visitors.FunctionDeclaration({
    params: [
      {
        type: "Identifier",
        typeAnnotation: {
          typeAnnotation: { type: "TSObjectKeyword" },
        },
      },
      {
        type: "Identifier",
        typeAnnotation: {
          typeAnnotation: {
            type: "TSUnionType",
            types: [{ type: "TSStringKeyword" }, { type: "TSObjectKeyword" }],
          },
        },
      },
      {
        type: "Identifier",
        typeAnnotation: {
          typeAnnotation: {
            type: "TSTypeReference",
            typeName: { type: "Identifier", name: "StructuredValue" },
          },
        },
      },
      {
        type: "Identifier",
        typeAnnotation: {
          typeAnnotation: {
            type: "TSTypeReference",
            typeName: { type: "Identifier", name: "Review" },
          },
        },
      },
    ],
  })
  assert.equal(reports.length, 3)
})

test("no-conditional-empty-object-spread rejects omission tricks", () => {
  const empty = { type: "ObjectExpression", properties: [] }
  const populated = { type: "ObjectExpression", properties: [{ type: "Property" }] }
  const reports = reportsFor("no-conditional-empty-object-spread", "SpreadElement", {
    type: "SpreadElement",
    parent: { type: "ObjectExpression" },
    argument: {
      type: "ConditionalExpression",
      consequent: populated,
      alternate: empty,
    },
  })
  assert.equal(reports.length, 1)
})

test("no-chained-type-assertions rejects nested assertions", () => {
  const inner = {
    type: "TSAsExpression",
    expression: { type: "Identifier" },
    parent: null,
  }
  const outer = {
    type: "TSAsExpression",
    expression: inner,
    parent: { type: "ExpressionStatement" },
  }
  inner.parent = outer
  const reports = reportsFor("no-chained-type-assertions", "TSAsExpression", outer)
  assert.equal(reports.length, 1)
})

test("no-unsafe-dictionary-type rejects broad Record values", () => {
  const reports = []
  const visitors = diffdashLintRules["no-unsafe-dictionary-type"].create({
    report: (report) => reports.push(report),
  })
  visitors.Program({ type: "Program", body: [] })
  visitors.TSTypeReference({
    type: "TSTypeReference",
    start: 0,
    end: 24,
    typeName: { type: "Identifier", name: "Record" },
    typeArguments: {
      params: [{ type: "TSStringKeyword" }, { type: "TSUnknownKeyword" }],
    },
  })
  assert.equal(reports.length, 1)
})

test("no-known-value-widening rejects a known object assigned to object", () => {
  const reports = []
  const visitors = diffdashLintRules["no-known-value-widening"].create({
    report: (report) => reports.push(report),
    sourceCode: { getScope: () => null },
  })
  visitors.Program({ type: "Program", body: [] })
  visitors.VariableDeclarator({
    id: {
      type: "Identifier",
      name: "value",
      typeAnnotation: { typeAnnotation: { type: "TSObjectKeyword" } },
    },
    init: { type: "ObjectExpression", properties: [] },
  })
  assert.equal(reports.length, 1)
})

test("no-widen-then-assert rejects restoring erased local evidence", () => {
  const initializer = { type: "ObjectExpression", properties: [] }
  const declarator = {
    type: "VariableDeclarator",
    id: {
      type: "Identifier",
      name: "value",
      typeAnnotation: { typeAnnotation: { type: "TSObjectKeyword" } },
    },
    init: initializer,
    parent: { type: "VariableDeclaration", kind: "const" },
  }
  const variable = {
    defs: [{ type: "Variable", node: declarator }],
    references: [],
  }
  const reports = []
  const visitors = diffdashLintRules["no-widen-then-assert"].create({
    report: (report) => reports.push(report),
    sourceCode: {
      getScope: () => ({ set: new Map([["value", variable]]), upper: null }),
    },
  })
  visitors.Program({ type: "Program", body: [] })
  visitors.TSAsExpression({
    type: "TSAsExpression",
    expression: { type: "Identifier", name: "value" },
    typeAnnotation: {
      type: "TSTypeLiteral",
      members: [{ type: "TSPropertySignature" }],
    },
  })
  assert.equal(reports.length, 1)
})
