const noRuntimeTypeof = {
  create(context) {
    return {
      UnaryExpression(node) {
        if (node.operator === "typeof") {
          context.report({
            node,
            message:
              "Avoid runtime typeof; use a schema, Effect Predicate, typed discriminant, or platform-safe access.",
          })
        }
      },
    }
  },
}

const isTagMember = (node) =>
  node?.type === "MemberExpression" &&
  ((node.computed === false &&
    node.property.type === "Identifier" &&
    node.property.name === "_tag") ||
    (node.computed === true && node.property.type === "Literal" && node.property.value === "_tag"))

const containsTagMember = (node) => {
  if (node === null || typeof node !== "object") return false
  if (isTagMember(node)) return true
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue
    if (Array.isArray(value) ? value.some(containsTagMember) : containsTagMember(value)) return true
  }
  return false
}

const isControlFlowTest = (node) => {
  let current = node.parent
  while (current !== undefined) {
    if (
      current.type === "IfStatement" ||
      current.type === "ConditionalExpression" ||
      current.type === "WhileStatement" ||
      current.type === "DoWhileStatement" ||
      current.type === "ForStatement"
    ) {
      return true
    }
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      return false
    }
    current = current.parent
  }
  return false
}

const noManualTagMatch = {
  create(context) {
    return {
      BinaryExpression(node) {
        if (
          ["==", "===", "!=", "!=="].includes(node.operator) &&
          (isTagMember(node.left) || isTagMember(node.right)) &&
          !isControlFlowTest(node)
        ) {
          context.report({
            node,
            message:
              "Use Effect Match for tagged-union control flow instead of comparing _tag manually.",
          })
        }
      },
      SwitchStatement(node) {
        if (containsTagMember(node.discriminant)) {
          context.report({
            node: node.discriminant,
            message: "Use Effect Match for tagged-union control flow instead of switching on _tag.",
          })
        }
      },
      IfStatement(node) {
        if (containsTagMember(node.test)) {
          context.report({
            node: node.test,
            message:
              "Use Effect Match for tagged-union control flow instead of reading _tag in a condition.",
          })
        }
      },
      ConditionalExpression(node) {
        if (containsTagMember(node.test)) {
          context.report({
            node: node.test,
            message:
              "Use Effect Match for tagged-union control flow instead of reading _tag in a condition.",
          })
        }
      },
      WhileStatement(node) {
        if (containsTagMember(node.test)) {
          context.report({
            node: node.test,
            message:
              "Use Effect Match for tagged-union control flow instead of reading _tag in a condition.",
          })
        }
      },
      DoWhileStatement(node) {
        if (containsTagMember(node.test)) {
          context.report({
            node: node.test,
            message:
              "Use Effect Match for tagged-union control flow instead of reading _tag in a condition.",
          })
        }
      },
      ForStatement(node) {
        if (node.test !== null && containsTagMember(node.test)) {
          context.report({
            node: node.test,
            message:
              "Use Effect Match for tagged-union control flow instead of reading _tag in a condition.",
          })
        }
      },
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern") return
        for (const property of node.id.properties) {
          if (
            property.type === "Property" &&
            ((property.computed === false &&
              property.key.type === "Identifier" &&
              property.key.name === "_tag") ||
              (property.computed === true &&
                property.key.type === "Literal" &&
                property.key.value === "_tag"))
          ) {
            context.report({
              node: property,
              message: "Use Effect Match instead of destructuring _tag for control flow.",
            })
          }
        }
      },
    }
  },
}

const noInstanceof = {
  create(context) {
    return {
      BinaryExpression(node) {
        if (node.operator === "instanceof") {
          context.report({
            node,
            message: "Avoid instanceof; use Effect Match, a schema, or a structural predicate.",
          })
        }
      },
    }
  },
}

export default {
  meta: { name: "diffdash" },
  rules: {
    "no-runtime-typeof": noRuntimeTypeof,
    "no-manual-tag-match": noManualTagMatch,
    "no-instanceof": noInstanceof,
  },
}
