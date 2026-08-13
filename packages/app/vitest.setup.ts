if (!("self" in globalThis)) {
  Object.defineProperty(globalThis, "self", { value: globalThis })
}

if (!("addEventListener" in globalThis)) {
  Object.defineProperty(globalThis, "addEventListener", { value: () => undefined })
}
