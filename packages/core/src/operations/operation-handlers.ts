import type { Effect } from "effect"

import {
  CoreMethod,
  type CoreMethod as CoreMethodType,
  type CoreMethodInput,
  type CoreOperationFailure,
  type CoreOperationOptions,
  type CoreOperationOutput,
} from "../core-contract"

/** Handler for one closed Core operation with its correlated input, output, and failure types. */
export type OperationHandler<Method extends CoreMethodType> = (
  input: CoreMethodInput<Method>,
  options: CoreOperationOptions,
) => Effect.Effect<CoreOperationOutput<Method>, CoreOperationFailure<Method>>

/** Correctly typed handler map for one cohesive subset of Core operations. */
export type OperationHandlersFor<Methods extends CoreMethodType> = {
  readonly [Method in Methods]: OperationHandler<Method>
}

/** Exhaustive handler map for the complete closed Core method catalog. */
export type OperationHandlers = OperationHandlersFor<CoreMethodType>

/** Rejects accidental operation ownership overlap before partial handler maps are composed. */
export const assertUniqueOperationHandlers = (
  capabilities: ReadonlyArray<Readonly<Partial<OperationHandlers>>>,
): void => {
  for (const method of Object.values(CoreMethod)) {
    let hasOwner = false
    for (const capability of capabilities) {
      if (!Object.hasOwn(capability, method)) continue
      if (hasOwner) {
        throw new Error(`Core operation ${method} has more than one handler.`)
      }
      hasOwner = true
    }
  }
}
