import { Predicate, Schema } from "effect"

const CoreDefectSummaryText = Schema.String.pipe(Schema.check(Schema.isMaxLength(256)))

/** Bounded, serializable details retained when Core encounters an unexpected defect. */
export const CoreDefectSummary = Schema.Struct({
  tag: CoreDefectSummaryText,
  name: CoreDefectSummaryText,
  message: CoreDefectSummaryText,
})

/** Bounded, serializable details retained when Core encounters an unexpected defect. */
export type CoreDefectSummary = typeof CoreDefectSummary.Type

/** The private representation of a defect captured before it reaches a Core boundary. */
export interface CapturedCoreDefect {
  readonly cause: Error
  readonly summary: CoreDefectSummary
}

/** Captures an arbitrary defect as bounded diagnostics and a safe rejection cause. */
export const captureCoreDefect = <Defect>(defect: Defect): CapturedCoreDefect => ({
  cause: toCoreExpectedCause(defect),
  summary: summarizeCoreDefect(defect),
})

/** Converts an arbitrary adapter value into the typed cause retained by Core failures. */
export const toCoreExpectedCause = <Value>(value: Value): Error =>
  Predicate.isError(value) ? value : new Error("Core operation failed")

/** Extracts bounded, serializable details from an arbitrary defect. */
export const summarizeCoreDefect = <Defect>(defect: Defect): CoreDefectSummary =>
  summarizeCoreDefectValue(defect)

const summarizeCoreDefectValue = <Defect>(defect: Defect): CoreDefectSummary => {
  const tag =
    defectProperty(defect, "_tag") ?? (Predicate.isError(defect) ? "Error" : "UnknownDefect")
  const name =
    defectProperty(defect, "name") ?? (Predicate.isError(defect) ? "Error" : "UnknownDefect")
  const message = defectProperty(defect, "message") ?? safeDefectString(defect, "Unknown defect")

  return CoreDefectSummary.make({
    tag: boundDefectText(tag),
    name: boundDefectText(name),
    message: boundDefectText(message),
  })
}

const defectProperty = <Defect>(
  defect: Defect,
  property: "_tag" | "name" | "message",
): string | undefined => {
  if (!Predicate.isObject(defect)) return undefined
  try {
    const value = Reflect.get(defect, property)
    return Predicate.isString(value) ? value : undefined
  } catch {
    return undefined
  }
}

const safeDefectString = <Defect>(defect: Defect, fallback: string): string => {
  try {
    return String(defect)
  } catch {
    return fallback
  }
}

const boundDefectText = (value: string): string => value.slice(0, 256)
