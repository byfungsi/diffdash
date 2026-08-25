import { Array as EffectArray, HashMap, Option, Order } from "effect"
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import type {
  OwnedExtensionContribution,
  ReviewDiffContribution,
  ReviewDiffContributionOutput,
  ReviewDiffContributionProps,
} from "@/extensions/extension-registry"

interface RegisteredReviewDiffContribution {
  readonly key: string
  readonly id: string
  readonly order: number
  readonly output: ReviewDiffContributionOutput
  readonly token: object
}

/** Identified live output retained by the review host. */
export interface IdentifiedReviewDiffContributionOutput {
  readonly id: string
  readonly output: ReviewDiffContributionOutput
}

interface ReviewDiffContributionRegistration {
  readonly mount: (output: ReviewDiffContributionOutput) => () => void
  readonly update: (output: ReviewDiffContributionOutput) => void
}

const ReviewDiffContributionRegistrationContext = createContext<
  ReviewDiffContributionRegistration | undefined
>(undefined)

const contributionOrder = Order.make<RegisteredReviewDiffContribution>((left, right) => {
  if (left.order < right.order) return -1
  if (left.order > right.order) return 1
  if (left.id < right.id) return -1
  if (left.id > right.id) return 1
  return 0
})

/** Registers live behavior from the current review contribution mount. */
export const useReviewDiffContributionRegistration = (
  output: ReviewDiffContributionOutput,
): void => {
  const registration = use(ReviewDiffContributionRegistrationContext)
  if (registration === undefined) throw new Error("ReviewDiffContributionHost is unavailable")
  const initialOutput = useRef(output)
  useLayoutEffect(() => registration.mount(initialOutput.current), [registration])
  useLayoutEffect(() => registration.update(output), [output, registration])
}

/** Mounts ordered review contributions and returns their ownership-safe live outputs. */
export const useReviewDiffContributionHost = (
  contributions: readonly OwnedExtensionContribution<ReviewDiffContribution>[],
  props: ReviewDiffContributionProps,
): {
  readonly mounts: ReactNode
  readonly outputs: readonly IdentifiedReviewDiffContributionOutput[]
  readonly semantic: Pick<
    ReviewDiffContributionOutput,
    "activeLineAnchor" | "details" | "annotations" | "activateLine" | "annotationsRendered"
  >
} => {
  const [registrations, setRegistrations] = useState<
    HashMap.HashMap<string, RegisteredReviewDiffContribution>
  >(HashMap.empty)
  const register = useCallback(
    (key: string, id: string, order: number, output: ReviewDiffContributionOutput) => {
      const registration: RegisteredReviewDiffContribution = {
        key,
        id,
        order,
        output,
        token: {},
      }
      setRegistrations((current) => HashMap.set(current, key, registration))
      return () =>
        setRegistrations((current) => {
          const currentRegistration = HashMap.get(current, key)
          if (!Option.exists(currentRegistration, ({ token }) => token === registration.token)) {
            return current
          }
          return HashMap.remove(current, key)
        })
    },
    [],
  )
  const update = useCallback((key: string, output: ReviewDiffContributionOutput) => {
    setRegistrations((current) => {
      return Option.match(HashMap.get(current, key), {
        onNone: () => current,
        onSome: (registration) =>
          registration.output === output
            ? current
            : HashMap.set(current, key, { ...registration, output }),
      })
    })
  }, [])
  const ordered = useMemo(
    () =>
      EffectArray.sort(
        Array.from(registrations, ([, registration]) => registration),
        contributionOrder,
      ),
    [registrations],
  )
  const scopeKey = JSON.stringify([
    props.projectId,
    props.target,
    props.baseRevision,
    props.headRevision,
  ])
  const mounts = contributions.map((contribution) => (
    <ReviewDiffContributionScope
      key={`${contribution.ownerExtensionId}:${contribution.id}:${contribution.ownerRegistrationToken.reactKey}:${scopeKey}`}
      contribution={contribution}
      props={props}
      register={register}
      update={update}
    />
  ))
  const outputs = useMemo(() => ordered.map(({ id, output }) => ({ id, output })), [ordered])
  const semantic = useMemo(
    () =>
      ({
        activeLineAnchor: Option.firstSomeOf(outputs.map(({ output }) => output.activeLineAnchor)),
        details: outputs.flatMap(({ output }) => output.details),
        annotations: (file, navigationAnchor) =>
          outputs.flatMap(({ output }) => output.annotations(file, navigationAnchor)),
        activateLine: (file, side, lineNumber) =>
          outputs.some(({ output }) => output.activateLine(file, side, lineNumber)),
        annotationsRendered: (card) => {
          for (const { output } of outputs) output.annotationsRendered(card)
        },
      }) satisfies Pick<
        ReviewDiffContributionOutput,
        "activeLineAnchor" | "details" | "annotations" | "activateLine" | "annotationsRendered"
      >,
    [outputs],
  )
  return { mounts, outputs, semantic }
}

const ReviewDiffContributionScope = ({
  contribution,
  props,
  register,
  update,
}: {
  readonly contribution: OwnedExtensionContribution<ReviewDiffContribution>
  readonly props: ReviewDiffContributionProps
  readonly register: (
    key: string,
    id: string,
    order: number,
    output: ReviewDiffContributionOutput,
  ) => () => void
  readonly update: (key: string, output: ReviewDiffContributionOutput) => void
}) => {
  const contributionKey = `${contribution.ownerExtensionId}:${contribution.id}`
  const mountOutput = useCallback(
    (output: ReviewDiffContributionOutput) =>
      register(contributionKey, contribution.id, contribution.order, output),
    [contribution.id, contribution.order, contributionKey, register],
  )
  const updateOutput = useCallback(
    (output: ReviewDiffContributionOutput) => update(contributionKey, output),
    [contributionKey, update],
  )
  const registration = useMemo(
    () => ({ mount: mountOutput, update: updateOutput }),
    [mountOutput, updateOutput],
  )
  const Component = contribution.component
  return (
    <ReviewDiffContributionRegistrationContext value={registration}>
      <Component {...props} />
    </ReviewDiffContributionRegistrationContext>
  )
}
