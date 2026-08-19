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

const unwrapType = (node) => {
  let current = node
  while (current?.type === "TSParenthesizedType") current = current.typeAnnotation
  return current
}

const typeReferenceName = (node) =>
  node?.type === "TSTypeReference" && node.typeName.type === "Identifier"
    ? node.typeName.name
    : null

const buildTypeAliases = (program) => {
  const aliases = new Map()
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
    if (declaration?.type === "TSTypeAliasDeclaration" && !declaration.typeParameters) {
      aliases.set(declaration.id.name, declaration.typeAnnotation)
    }
  }
  return aliases
}

const resolveAlias = (node, aliases, visited = new Set()) => {
  const type = unwrapType(node)
  const name = typeReferenceName(type)
  if (name === null || type.typeArguments?.params.length || visited.has(name)) return type
  const aliased = aliases.get(name)
  if (aliased === undefined) return type
  const nextVisited = new Set(visited)
  nextVisited.add(name)
  return resolveAlias(aliased, aliases, nextVisited)
}

const isUnsafeValueType = (node, aliases, visited = new Set()) => {
  const type = unwrapType(node)
  if (
    type?.type === "TSUnknownKeyword" ||
    type?.type === "TSAnyKeyword" ||
    type?.type === "TSObjectKeyword" ||
    (type?.type === "TSTypeLiteral" && type.members.length === 0)
  ) {
    return true
  }
  if (type?.type === "TSUnionType") {
    return type.types.some((member) => isUnsafeValueType(member, aliases, visited))
  }
  const name = typeReferenceName(type)
  if (name === null || type.typeArguments?.params.length || visited.has(name)) return false
  const aliased = aliases.get(name)
  if (aliased === undefined) return false
  const nextVisited = new Set(visited)
  nextVisited.add(name)
  return isUnsafeValueType(aliased, aliases, nextVisited)
}

const isBroadKeyType = (node) => {
  const type = unwrapType(node)
  if (["TSStringKeyword", "TSNumberKeyword", "TSSymbolKeyword"].includes(type?.type)) return true
  if (type?.type === "TSUnionType") return type.types.every(isBroadKeyType)
  return typeReferenceName(type) === "PropertyKey"
}

const unsafeDictionaryValue = (node, aliases, visited = new Set()) => {
  const type = unwrapType(node)
  if (type?.type === "TSTypeReference") {
    const name = typeReferenceName(type)
    const parameters = type.typeArguments?.params ?? []
    if (
      (name === "Record" || name === "ReadonlyRecord") &&
      parameters.length === 2 &&
      isBroadKeyType(parameters[0]) &&
      isUnsafeValueType(parameters[1], aliases)
    ) {
      return parameters[1]
    }
    if (name === "Readonly" && parameters.length === 1) {
      return unsafeDictionaryValue(parameters[0], aliases, visited)
    }
    if (name !== null && parameters.length === 0 && !visited.has(name)) {
      const aliased = aliases.get(name)
      if (aliased !== undefined) {
        const nextVisited = new Set(visited)
        nextVisited.add(name)
        return unsafeDictionaryValue(aliased, aliases, nextVisited)
      }
    }
  }
  if (type?.type === "TSTypeLiteral" && type.members.length === 1) {
    const [member] = type.members
    const [parameter] = member?.type === "TSIndexSignature" ? member.parameters : []
    if (
      member?.type === "TSIndexSignature" &&
      member.parameters.length === 1 &&
      parameter?.typeAnnotation &&
      isBroadKeyType(parameter.typeAnnotation.typeAnnotation) &&
      member.typeAnnotation &&
      isUnsafeValueType(member.typeAnnotation.typeAnnotation, aliases)
    ) {
      return member.typeAnnotation.typeAnnotation
    }
  }
  if (type?.type === "TSMappedType" && type.typeAnnotation) {
    if (isUnsafeValueType(type.typeAnnotation, aliases)) return type.typeAnnotation
  }
  return null
}

const broadTypeKind = (node, aliases) => {
  const type = resolveAlias(node, aliases)
  if (type?.type === "TSUnknownKeyword" || type?.type === "TSAnyKeyword") return "top type"
  if (type?.type === "TSObjectKeyword") return "object type"
  if (type?.type === "TSTypeLiteral" && type.members.length === 0) return "empty object type"
  if (unsafeDictionaryValue(type, aliases) !== null) return "unsafe dictionary type"
  if (
    type?.type === "TSTypeReference" &&
    (type.typeArguments?.params ?? []).some((parameter) => isUnsafeValueType(parameter, aliases))
  ) {
    return "broad generic type"
  }
  return null
}

const parameterAnnotation = (parameter) => {
  if (parameter.type === "TSParameterProperty") return parameterAnnotation(parameter.parameter)
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument)
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation
  }
  return parameter.typeAnnotation
}

const parameterVisitors = (check) => ({
  ArrowFunctionExpression: check,
  FunctionDeclaration: check,
  FunctionExpression: check,
  TSCallSignatureDeclaration: check,
  TSConstructSignatureDeclaration: check,
  TSConstructorType: check,
  TSDeclareFunction: check,
  TSEmptyBodyFunctionExpression: check,
  TSFunctionType: check,
  TSMethodSignature: check,
})

const containsObjectType = (node, aliases, visited = new Set()) => {
  const type = unwrapType(node)
  if (type?.type === "TSObjectKeyword") return true
  if (type?.type === "TSUnionType" || type?.type === "TSIntersectionType") {
    return type.types.some((member) => containsObjectType(member, aliases, visited))
  }
  const name = typeReferenceName(type)
  if (name === null || type.typeArguments?.params.length || visited.has(name)) return false
  const aliased = aliases.get(name)
  if (aliased === undefined) return false
  const nextVisited = new Set(visited)
  nextVisited.add(name)
  return containsObjectType(aliased, aliases, nextVisited)
}

const noObjectParameters = {
  create(context) {
    let aliases = new Map()
    const check = (node) => {
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter)
        if (annotation && containsObjectType(annotation.typeAnnotation, aliases)) {
          context.report({
            node: annotation.typeAnnotation,
            message:
              "Avoid broad object parameters; use an owner-provided type, a precise generic, or decode the value at its boundary.",
          })
        }
      }
    }
    return {
      Program(node) {
        aliases = buildTypeAliases(node)
      },
      ...parameterVisitors(check),
    }
  },
}

const noUnsafeDictionaryType = {
  create(context) {
    let aliases = new Map()
    const reported = new Set()
    const check = (node) => {
      const unsafe = unsafeDictionaryValue(node, aliases)
      if (unsafe === null) return
      const key = `${node.start}:${node.end}`
      if (reported.has(key)) return
      reported.add(key)
      context.report({
        node: unsafe,
        message:
          "Avoid dictionaries with unknown, any, object, or empty-object values; use a concrete owner or schema-derived value type.",
      })
    }
    return {
      Program(node) {
        aliases = buildTypeAliases(node)
      },
      TSTypeAliasDeclaration(node) {
        check(node.typeAnnotation)
      },
      TSTypeReference: check,
      TSTypeLiteral: check,
      TSMappedType: check,
    }
  },
}

const unwrapExpression = (node) => {
  let current = node
  while (
    [
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSTypeAssertion",
      "TSNonNullExpression",
    ].includes(current?.type)
  ) {
    current = current.expression
  }
  return current
}

const isKnownEvidenceExpression = (node) =>
  [
    "ArrayExpression",
    "ArrowFunctionExpression",
    "ClassExpression",
    "FunctionExpression",
    "Literal",
    "NewExpression",
    "ObjectExpression",
    "TemplateLiteral",
  ].includes(unwrapExpression(node)?.type)

const resolveVariable = (sourceCode, identifier) => {
  let scope = sourceCode.getScope(identifier)
  while (scope !== null) {
    const variable = scope.set.get(identifier.name)
    if (variable !== undefined) return variable
    scope = scope.upper
  }
  return null
}

const variableDeclarator = (variable) => {
  if (variable?.defs.length !== 1) return null
  const [definition] = variable.defs
  return definition?.type === "Variable" && definition.node.type === "VariableDeclarator"
    ? definition.node
    : null
}

const hasKnownEvidence = (sourceCode, expression, visited = new Set()) => {
  if (isKnownEvidenceExpression(expression)) return true
  const unwrapped = unwrapExpression(expression)
  if (unwrapped?.type !== "Identifier") return false
  const variable = resolveVariable(sourceCode, unwrapped)
  if (variable === null || visited.has(variable)) return false
  const declarator = variableDeclarator(variable)
  if (
    declarator === null ||
    declarator.init === null ||
    declarator.parent.type !== "VariableDeclaration" ||
    declarator.parent.kind !== "const" ||
    variable.references.some((reference) => reference.isWrite() && !reference.init)
  ) {
    return false
  }
  const nextVisited = new Set(visited)
  nextVisited.add(variable)
  return hasKnownEvidence(sourceCode, declarator.init, nextVisited)
}

const functionOwner = (node) => {
  let current = node.parent
  while (current && current.type !== "Program") {
    if (
      ["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"].includes(
        current.type,
      )
    ) {
      return current
    }
    current = current.parent
  }
  return null
}

const noKnownValueWidening = {
  create(context) {
    let aliases = new Map()
    const report = (expression, typeNode, subject) => {
      if (!typeNode || !hasKnownEvidence(context.sourceCode, expression)) return
      const kind = broadTypeKind(typeNode, aliases)
      if (kind === null) return
      context.report({
        node: expression,
        message: `Do not widen the known ${subject} to a ${kind}; preserve inference, use satisfies, or use a named owner contract.`,
      })
    }
    return {
      Program(node) {
        aliases = buildTypeAliases(node)
      },
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && node.init) {
          report(node.init, node.id.typeAnnotation?.typeAnnotation, `value of ${node.id.name}`)
        }
      },
      PropertyDefinition(node) {
        if (node.value) report(node.value, node.typeAnnotation?.typeAnnotation, "property value")
      },
      ReturnStatement(node) {
        if (node.argument)
          report(node.argument, functionOwner(node)?.returnType?.typeAnnotation, "return value")
      },
      ArrowFunctionExpression(node) {
        if (node.body.type !== "BlockStatement") {
          report(node.body, node.returnType?.typeAnnotation, "return value")
        }
      },
      TSAsExpression(node) {
        if (node.parent.type !== "TSAsExpression") {
          report(node.expression, node.typeAnnotation, "asserted value")
        }
      },
      TSTypeAssertion(node) {
        if (node.parent.type !== "TSTypeAssertion") {
          report(node.expression, node.typeAnnotation, "asserted value")
        }
      },
    }
  },
}

const isTypeAssertion = (node) =>
  node?.type === "TSAsExpression" || node?.type === "TSTypeAssertion"

const noChainedTypeAssertions = {
  create(context) {
    const check = (node) => {
      if (isTypeAssertion(node.parent) && node.parent.expression === node) return
      let current = node
      let count = 0
      while (isTypeAssertion(current)) {
        count += 1
        current = current.expression
        while (current?.type === "ParenthesizedExpression") current = current.expression
      }
      if (count > 1) {
        context.report({
          node,
          message:
            "Do not chain type assertions; preserve the original type or parse genuinely external input at its boundary.",
        })
      }
    }
    return { TSAsExpression: check, TSTypeAssertion: check }
  },
}

const noWidenThenAssert = {
  create(context) {
    let aliases = new Map()
    const check = (node) => {
      const expression = unwrapExpression(node.expression)
      if (expression?.type !== "Identifier") return
      const variable = resolveVariable(context.sourceCode, expression)
      const declarator = variableDeclarator(variable)
      if (
        declarator === null ||
        declarator.init === null ||
        declarator.id.type !== "Identifier" ||
        declarator.parent.type !== "VariableDeclaration" ||
        declarator.parent.kind !== "const" ||
        !hasKnownEvidence(context.sourceCode, declarator.init)
      ) {
        return
      }
      const annotation = declarator.id.typeAnnotation?.typeAnnotation
      const initializerAssertion = isTypeAssertion(declarator.init)
        ? declarator.init.typeAnnotation
        : null
      if (broadTypeKind(annotation ?? initializerAssertion, aliases) === null) return
      if (broadTypeKind(node.typeAnnotation, aliases) !== null) return
      context.report({
        node,
        message: `Binding ${expression.name} widens known evidence and later asserts it back; preserve its precise type end-to-end.`,
      })
    }
    return {
      Program(node) {
        aliases = buildTypeAliases(node)
      },
      TSAsExpression: check,
      TSTypeAssertion: check,
    }
  },
}

const noConditionalEmptyObjectSpread = {
  create(context) {
    return {
      SpreadElement(node) {
        if (node.parent.type !== "ObjectExpression") return
        const expression = unwrapExpression(node.argument)
        if (expression?.type !== "ConditionalExpression") return
        const isEmptyObject = (branch) =>
          unwrapExpression(branch)?.type === "ObjectExpression" &&
          unwrapExpression(branch).properties.length === 0
        if (!isEmptyObject(expression.consequent) && !isEmptyObject(expression.alternate)) return
        context.report({
          node,
          message:
            "Avoid conditional empty-object spreads; construct the precise object branch or assign the optional property explicitly.",
        })
      },
    }
  },
}

export const diffdashLintRules = {
  "no-runtime-typeof": noRuntimeTypeof,
  "no-manual-tag-match": noManualTagMatch,
  "no-instanceof": noInstanceof,
  "no-known-value-widening": noKnownValueWidening,
  "no-widen-then-assert": noWidenThenAssert,
  "no-unsafe-dictionary-type": noUnsafeDictionaryType,
  "no-chained-type-assertions": noChainedTypeAssertions,
  "no-object-parameters": noObjectParameters,
  "no-conditional-empty-object-spread": noConditionalEmptyObjectSpread,
}

export default {
  meta: { name: "diffdash" },
  rules: diffdashLintRules,
}
