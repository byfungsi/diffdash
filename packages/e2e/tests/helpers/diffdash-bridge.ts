type UnwrapBridgeValue<Value> = Value extends {
  readonly _tag: "Success"
  readonly value: infer Result
}
  ? Result
  : Value extends { readonly _tag: "Failure" }
    ? never
    : Value

type UnwrapBridgeMember<Value> = Value extends (
  ...arguments_: infer Arguments
) => Promise<infer Result>
  ? (...arguments_: Arguments) => Promise<UnwrapBridgeValue<Result>>
  : Value extends (...arguments_: infer Arguments) => infer Result
    ? (...arguments_: Arguments) => Result
    : Value extends object
      ? { readonly [Key in keyof Value]: UnwrapBridgeMember<Value[Key]> }
      : Value

type DiffDashE2eApi = UnwrapBridgeMember<Window["diffDash"]>

type BridgeResult<Value> =
  | { readonly _tag: "Success"; readonly value: Value }
  | { readonly _tag: "Failure"; readonly error: { readonly message: string } }

declare global {
  interface Window {
    readonly diffDashForE2e: DiffDashE2eApi
  }
}

/** Installs a renderer-local proxy that unwraps bridge results for E2E assertions. */
export const installDiffDashE2eApi = (): void => {
  // These helpers stay inside the installer because Playwright serializes its function body.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
    typeof value === "object" && value !== null

  const isBridgeResult = (value: unknown): value is BridgeResult<unknown> =>
    isRecord(value) &&
    (Reflect.get(value, "_tag") === "Success" || Reflect.get(value, "_tag") === "Failure")

  const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
    isRecord(value) && typeof value.then === "function"

  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const unwrap = (result: BridgeResult<unknown>): unknown => {
    if ("error" in result) throw new Error(result.error.message)
    return result.value
  }

  const proxy = (source: object): object =>
    new Proxy(Object.create(null) as object, {
      get(_target, property) {
        const member = Reflect.get(source, property)
        if (typeof member === "function") {
          return (...arguments_: readonly unknown[]) => {
            const result = Reflect.apply(member, source, arguments_)
            return isPromiseLike(result)
              ? result.then((value) => (isBridgeResult(value) ? unwrap(value) : value))
              : result
          }
        }
        return typeof member === "object" && member !== null ? proxy(member) : member
      },
    })

  Object.defineProperty(globalThis.window, "diffDashForE2e", {
    configurable: true,
    value: proxy(globalThis.window.diffDash),
  })
}
