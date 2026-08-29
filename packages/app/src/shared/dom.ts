import { Predicate } from "effect"

/** Narrows a value to an HTML element using stable DOM surface properties. */
export const isHTMLElement = <Value>(value: Value): value is Value & HTMLElement =>
  Predicate.isObject(value) &&
  "nodeType" in value &&
  value.nodeType === 1 &&
  "tagName" in value &&
  Predicate.isString(value.tagName) &&
  "isConnected" in value &&
  Predicate.isBoolean(value.isConnected) &&
  "focus" in value &&
  Predicate.isFunction(value.focus)

/** Narrows a tree-walker value to a text node using stable DOM surface properties. */
export const isTextNode = <Value>(value: Value): value is Value & Text =>
  Predicate.isObject(value) &&
  "nodeType" in value &&
  value.nodeType === 3 &&
  "data" in value &&
  Predicate.isString(value.data)

/** Narrows a root node to the DOM roots that expose activeElement. */
export const isDocumentOrShadowRoot = <Value>(
  value: Value,
): value is Value & (Document | ShadowRoot) =>
  Predicate.isObject(value) &&
  "nodeType" in value &&
  (value.nodeType === 9 || value.nodeType === 11) &&
  "activeElement" in value

/** Identifies an abort DOM exception without relying on a realm-specific constructor. */
export const isAbortDOMException = <Value>(value: Value): value is Value & DOMException =>
  Predicate.isObject(value) &&
  "name" in value &&
  value.name === "AbortError" &&
  "message" in value &&
  Predicate.isString(value.message)

/** Returns whether a keyboard event target accepts direct text or value editing. */
export const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!isHTMLElement(target)) return false
  const tagName = target.tagName.toLowerCase()
  return (
    target.isContentEditable ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select"
  )
}
