import { Array as EffectArray, HashMap, Option, Order } from "effect"
import {
  createContext,
  Fragment,
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

interface CodeSourceHostAnnotationEntry {
  readonly contributionKey: string
  readonly annotationIndex: number
}

/** Grouped annotation metadata kept generic by the Code source host. */
export interface CodeSourceHostAnnotation {
  readonly entries: readonly CodeSourceHostAnnotationEntry[]
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
  readonly renderAnnotation: (annotation: CodeSourceHostAnnotation) => ReactNode
} => {
  const [registrations, setRegistrations] = useState<
    HashMap.HashMap<string, RegisteredCodeSourceContribution>
  >(HashMap.empty)
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
      setRegistrations((current) => HashMap.set(current, key, registration))
      setGeneration((current) => current + 1)
      return () => {
        setRegistrations((current) => {
          const currentRegistration = HashMap.get(current, key)
          if (!Option.exists(currentRegistration, ({ token }) => token === registration.token)) {
            return current
          }
          return HashMap.remove(current, key)
        })
        setGeneration((current) => current + 1)
      }
    },
    [],
  )

  const orderedRegistrations = EffectArray.sort(
    Array.from(HashMap.values(registrations)),
    registeredCodeSourceContributionOrder,
  )
  const annotationsByLine = new Map<number, CodeSourceHostAnnotationEntry[]>()
  for (const { key, output } of orderedRegistrations) {
    output.annotations.forEach(({ lineNumber }, annotationIndex) => {
      const entries = annotationsByLine.get(lineNumber) ?? []
      entries.push({ contributionKey: key, annotationIndex })
      annotationsByLine.set(lineNumber, entries)
    })
  }
  const annotations = Array.from(annotationsByLine, ([lineNumber, entries]) => ({
    lineNumber,
    metadata: { entries },
  }))
  const activateLine = useCallback(
    (lineNumber: number, lineContent: string): boolean => {
      const target: CodeSourceLineTarget = { ...source, lineNumber, lineContent }
      const ordered = EffectArray.sort(
        Array.from(HashMap.values(registrationsRef.current)),
        registeredCodeSourceContributionOrder,
      )
      return ordered.some(({ output }) => output.handleLineAction(target))
    },
    [source],
  )
  const renderAnnotation = (annotation: CodeSourceHostAnnotation): ReactNode =>
    annotation.entries.map(({ contributionKey, annotationIndex }) => (
      <Fragment key={`${contributionKey}:${String(annotationIndex)}`}>
        {Option.match(HashMap.get(registrations, contributionKey), {
          onNone: () => null,
          onSome: ({ output }) => output.annotations.at(annotationIndex)?.render() ?? null,
        })}
      </Fragment>
    ))
  const mounts = contributions.map((contribution) => (
    <CodeSourceContributionScope
      key={`${contribution.ownerExtensionId}:${contribution.id}:${contribution.ownerRegistrationToken.reactKey}`}
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
