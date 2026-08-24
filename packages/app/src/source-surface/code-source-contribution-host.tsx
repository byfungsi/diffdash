import { Array as EffectArray, Option, Order } from "effect"
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import type {
  CodeSourceContext,
  CodeSourceContribution,
  CodeSourceContributionOutput,
  CodeSourceLineTarget,
  OwnedExtensionContribution,
} from "@/extensions/extension-registry"

interface RegisteredCodeSourceContribution {
  readonly key: string
  readonly id: string
  readonly order: number
  readonly output: CodeSourceContributionOutput
  readonly token: object
}

const registeredCodeSourceContributionOrder = Order.make<RegisteredCodeSourceContribution>(
  (left, right) => {
    if (left.order < right.order) return -1
    if (left.order > right.order) return 1
    if (left.id < right.id) return -1
    if (left.id > right.id) return 1
    return 0
  },
)

interface CodeSourceContributionRegistration {
  readonly register: (output: CodeSourceContributionOutput) => () => void
}

const CodeSourceContributionRegistrationContext = createContext<
  CodeSourceContributionRegistration | undefined
>(undefined)

/** Annotation metadata kept generic by the Code source host. */
export interface CodeSourceHostAnnotation {
  readonly contributionKey: string
}

/** Registers the current extension component's semantic Code source behavior. */
export const useCodeSourceContributionRegistration = (
  output: CodeSourceContributionOutput,
): void => {
  const registration = use(CodeSourceContributionRegistrationContext)
  if (registration === undefined) {
    throw new Error("CodeSourceContributionHost is unavailable")
  }
  useEffect(() => registration.register(output), [output, registration])
}

/** Mounts ordered Code source contributions and projects their semantic output for Pierre. */
export const useCodeSourceContributionHost = (
  contributions: readonly OwnedExtensionContribution<CodeSourceContribution>[],
  source: CodeSourceContext,
): {
  readonly annotations: readonly {
    readonly lineNumber: number
    readonly metadata: CodeSourceHostAnnotation
  }[]
  readonly generation: number
  readonly mounts: ReactNode
  readonly activateLine: (lineNumber: number, lineContent: string) => boolean
  readonly renderAnnotation: (contributionKey: string) => ReactNode
} => {
  const [registrations, setRegistrations] = useState<
    ReadonlyMap<string, RegisteredCodeSourceContribution>
  >(new Map())
  const [generation, setGeneration] = useState(0)
  const registrationsRef = useRef(registrations)
  registrationsRef.current = registrations

  const register = useCallback(
    (
      key: string,
      id: string,
      order: number,
      output: CodeSourceContributionOutput,
    ): (() => void) => {
      const registration: RegisteredCodeSourceContribution = { key, id, order, output, token: {} }
      setRegistrations((current) => new Map(current).set(key, registration))
      setGeneration((current) => current + 1)
      return () => {
        setRegistrations((current) => {
          if (current.get(key)?.token !== registration.token) return current
          const next = new Map(current)
          next.delete(key)
          return next
        })
        setGeneration((current) => current + 1)
      }
    },
    [],
  )

  const orderedRegistrations = EffectArray.sort(
    [...registrations.values()],
    registeredCodeSourceContributionOrder,
  )
  const annotations = orderedRegistrations.flatMap(({ key, output }) =>
    Option.match(output.annotation, {
      onNone: () => [],
      onSome: ({ lineNumber }) => [{ lineNumber, metadata: { contributionKey: key } }],
    }),
  )
  const activateLine = useCallback(
    (lineNumber: number, lineContent: string): boolean => {
      const target: CodeSourceLineTarget = { ...source, lineNumber, lineContent }
      const ordered = EffectArray.sort(
        [...registrationsRef.current.values()],
        registeredCodeSourceContributionOrder,
      )
      return ordered.some(({ output }) => output.handleLineAction(target))
    },
    [source],
  )
  const renderAnnotation = (contributionKey: string): ReactNode => {
    const registration = registrations.get(contributionKey)
    if (registration === undefined) return null
    return Option.match(registration.output.annotation, {
      onNone: () => null,
      onSome: ({ render }) => render(),
    })
  }
  const mounts = contributions.map((contribution) => (
    <CodeSourceContributionScope
      key={`${contribution.ownerExtensionId}:${contribution.id}`}
      contribution={contribution}
      source={source}
      register={register}
    />
  ))

  return { activateLine, annotations, generation, mounts, renderAnnotation }
}

const CodeSourceContributionScope = ({
  contribution,
  source,
  register,
}: {
  readonly contribution: OwnedExtensionContribution<CodeSourceContribution>
  readonly source: CodeSourceContext
  readonly register: (
    key: string,
    id: string,
    order: number,
    output: CodeSourceContributionOutput,
  ) => () => void
}) => {
  const registerOutput = useCallback(
    (output: CodeSourceContributionOutput) =>
      register(
        `${contribution.ownerExtensionId}:${contribution.id}`,
        contribution.id,
        contribution.order,
        output,
      ),
    [contribution.id, contribution.order, contribution.ownerExtensionId, register],
  )
  const registration = useMemo(() => ({ register: registerOutput }), [registerOutput])
  const Component = contribution.component
  return (
    <CodeSourceContributionRegistrationContext value={registration}>
      <Component source={source} />
    </CodeSourceContributionRegistrationContext>
  )
}
