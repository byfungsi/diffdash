import { Effect, HashMap, Option, Ref, Schema } from "effect"
import { createContext, type ReactNode, use, useEffect, useEffectEvent, useRef } from "react"

import { isMacPlatform, keyboardShortcutModifierLabel } from "./keyboard-shortcut-platform"

/** One normalized key used by the application shortcut catalog. */
export const KeyboardShortcutToken = Schema.Literals([
  "mod",
  "shift",
  "enter",
  "escape",
  "slash",
  "digit",
  "b",
  "d",
  "f",
  "f4",
  "f12",
  "g",
  "k",
  "r",
  "s",
  "v",
])

/** One normalized key used by the application shortcut catalog. */
export type KeyboardShortcutToken = typeof KeyboardShortcutToken.Type

/** Stable IDs for commands that can be registered in an active UI context. */
export const KeyboardShortcutCommandId = Schema.Literals([
  "shortcuts.open",
  "navigation.goAnywhere",
  "navigation.selectRibbonActivity",
  "review.toggleSidebar",
  "review.openActions",
  "review.reload",
  "review.toggleViewedFile",
  "search.open",
  "search.next",
  "search.previous",
  "search.close",
  "comments.submit",
  "comments.sendNotes",
  "code.peek.goTo",
  "code.peek.next",
  "code.peek.previous",
  "code.reload",
])

/** Stable IDs for commands that can be registered in an active UI context. */
export type KeyboardShortcutCommandId = typeof KeyboardShortcutCommandId.Type

const KeyboardShortcutDefinition = Schema.Struct({
  id: KeyboardShortcutCommandId,
  label: Schema.String,
  keys: Schema.Array(Schema.Array(KeyboardShortcutToken)),
})

/** User-facing metadata and bindings for one keyboard command. */
export type KeyboardShortcutDefinition = typeof KeyboardShortcutDefinition.Type

const KeyboardShortcutSection = Schema.Struct({
  label: Schema.String,
  shortcuts: Schema.Array(KeyboardShortcutDefinition),
})

/** User-facing group of related keyboard commands. */
export type KeyboardShortcutSection = typeof KeyboardShortcutSection.Type

/** Catalog rendered by the shortcut guide and matched by the command registry. */
export const KEYBOARD_SHORTCUT_SECTIONS: readonly KeyboardShortcutSection[] = [
  {
    label: "General",
    shortcuts: [
      { id: "shortcuts.open", label: "Keyboard shortcuts", keys: [["mod", "slash"]] },
      { id: "navigation.goAnywhere", label: "Go anywhere", keys: [["mod", "k"]] },
      {
        id: "navigation.selectRibbonActivity",
        label: "Open ribbon item",
        keys: [["mod", "digit"]],
      },
    ],
  },
  {
    label: "Review",
    shortcuts: [
      { id: "review.toggleSidebar", label: "Toggle sidebar", keys: [["mod", "b"]] },
      { id: "review.openActions", label: "Review actions", keys: [["mod", "shift", "k"]] },
      { id: "review.reload", label: "Refresh review", keys: [["mod", "r"]] },
      { id: "review.toggleViewedFile", label: "Toggle viewed file", keys: [["v"]] },
    ],
  },
  {
    label: "Review Search",
    shortcuts: [
      { id: "search.open", label: "Search review", keys: [["mod", "f"]] },
      { id: "search.next", label: "Next match", keys: [["mod", "g"], ["enter"]] },
      {
        id: "search.previous",
        label: "Previous match",
        keys: [
          ["mod", "shift", "g"],
          ["shift", "enter"],
        ],
      },
      { id: "search.close", label: "Close search", keys: [["escape"]] },
    ],
  },
  {
    label: "Code Navigation",
    shortcuts: [
      { id: "code.reload", label: "Refresh repository files", keys: [["mod", "r"]] },
      { id: "code.peek.goTo", label: "Go to selected Peek result", keys: [["mod", "d"]] },
      { id: "code.peek.next", label: "Next Peek result", keys: [["f12"], ["f4"]] },
      {
        id: "code.peek.previous",
        label: "Previous Peek result",
        keys: [
          ["shift", "f12"],
          ["shift", "f4"],
        ],
      },
    ],
  },
  {
    label: "Comments",
    shortcuts: [
      { id: "comments.submit", label: "Submit comment", keys: [["mod", "enter"]] },
      {
        id: "comments.sendNotes",
        label: "Send collected notes",
        keys: [["mod", "shift", "s"]],
      },
    ],
  },
]

const TOKEN_LABELS: Readonly<Record<Exclude<KeyboardShortcutToken, "mod">, string>> = {
  b: "B",
  d: "D",
  digit: "1-9",
  enter: "Enter",
  escape: "Esc",
  f: "F",
  f4: "F4",
  f12: "F12",
  g: "G",
  k: "K",
  r: "R",
  s: "S",
  shift: "Shift",
  slash: "/",
  v: "V",
}

const definitions = HashMap.fromIterable(
  KEYBOARD_SHORTCUT_SECTIONS.flatMap((section) => section.shortcuts).map(
    (shortcut) => [shortcut.id, shortcut] as const,
  ),
)

interface KeyboardShortcutRegistration {
  readonly handle: (event: KeyboardEvent) => void
  readonly priority: number
  readonly sequence: number
  readonly when: (event: KeyboardEvent) => boolean
}

type RegisterKeyboardShortcut = (
  commandId: KeyboardShortcutCommandId,
  registration: Omit<KeyboardShortcutRegistration, "sequence">,
) => () => void

const KeyboardShortcutRegistryContext = createContext<Option.Option<RegisterKeyboardShortcut>>(
  Option.none(),
)

/** Owns the renderer's single command-level keydown listener and contextual registrations. */
export function KeyboardShortcutProvider({ children }: { readonly children: ReactNode }) {
  const registrationsRef = useRef(
    Ref.makeUnsafe(HashMap.empty<KeyboardShortcutCommandId, KeyboardShortcutRegistration[]>()),
  )
  const sequenceRef = useRef(0)
  const registerRef = useRef<Option.Option<RegisterKeyboardShortcut>>(Option.none())
  if (Option.isNone(registerRef.current)) {
    registerRef.current = Option.some((commandId, registration) => {
      const registered = { ...registration, sequence: sequenceRef.current + 1 }
      sequenceRef.current = registered.sequence
      const current = Option.getOrElse(
        HashMap.get(Ref.getUnsafe(registrationsRef.current), commandId),
        () => [],
      )
      Effect.runSync(
        Ref.update(registrationsRef.current, HashMap.set(commandId, [...current, registered])),
      )
      return () => {
        const remaining = Option.getOrElse(
          HashMap.get(Ref.getUnsafe(registrationsRef.current), commandId),
          () => [],
        ).filter((candidate) => candidate.sequence !== registered.sequence)
        const update =
          remaining.length === 0 ? HashMap.remove(commandId) : HashMap.set(commandId, remaining)
        Effect.runSync(Ref.update(registrationsRef.current, update))
      }
    })
  }

  useEffect(() => {
    const dispatch = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return
      let active = Option.none<KeyboardShortcutRegistration>()
      for (const [commandId, definition] of definitions) {
        if (!definition.keys.some((binding) => matchesBinding(event, binding))) continue
        const registrations = Option.getOrElse(
          HashMap.get(Ref.getUnsafe(registrationsRef.current), commandId),
          () => [],
        )
        const candidate = highestPriorityRegistration(registrations, event)
        if (Option.exists(candidate, (registration) => outranks(registration, active))) {
          active = candidate
        }
      }
      Option.map(active, (registration) => {
        event.preventDefault()
        event.stopPropagation()
        registration.handle(event)
      })
    }
    window.addEventListener("keydown", dispatch, true)
    return () => window.removeEventListener("keydown", dispatch, true)
  }, [])

  return (
    <KeyboardShortcutRegistryContext value={registerRef.current}>
      {children}
    </KeyboardShortcutRegistryContext>
  )
}

/** Registers one command handler while its owning UI context is active. */
export function useKeyboardShortcut(
  commandId: KeyboardShortcutCommandId,
  handle: (event: KeyboardEvent) => void,
  options: {
    readonly enabled?: boolean
    readonly priority?: number
    readonly when?: (event: KeyboardEvent) => boolean
  } = {},
) {
  const register = use(KeyboardShortcutRegistryContext)
  const handleFromEvent = useEffectEvent(handle)
  const whenFromEvent = useEffectEvent(options.when ?? alwaysActive)
  const enabled = options.enabled ?? true
  const priority = options.priority ?? 0

  useEffect(() => {
    if (Option.isNone(register) || !enabled) return undefined
    return register.value(commandId, {
      handle: handleFromEvent,
      priority,
      when: whenFromEvent,
    })
  }, [commandId, enabled, priority, register])
}

/** Formats the primary binding for a command using the current platform modifier. */
export function keyboardShortcutLabel(commandId: KeyboardShortcutCommandId): string {
  const binding = Option.match(HashMap.get(definitions, commandId), {
    onNone: () => [] as const,
    onSome: (definition) => definition.keys[0] ?? [],
  })
  return binding.map(keyboardShortcutTokenLabel).join(" + ")
}

/** Returns the display label for one shortcut token. */
export function keyboardShortcutTokenLabel(token: KeyboardShortcutToken): string {
  const labels = {
    mod: keyboardShortcutModifierLabel,
    shift: () => TOKEN_LABELS.shift,
    enter: () => TOKEN_LABELS.enter,
    escape: () => TOKEN_LABELS.escape,
    slash: () => TOKEN_LABELS.slash,
    digit: () => TOKEN_LABELS.digit,
    b: () => TOKEN_LABELS.b,
    d: () => TOKEN_LABELS.d,
    f: () => TOKEN_LABELS.f,
    f4: () => TOKEN_LABELS.f4,
    f12: () => TOKEN_LABELS.f12,
    g: () => TOKEN_LABELS.g,
    k: () => TOKEN_LABELS.k,
    r: () => TOKEN_LABELS.r,
    s: () => TOKEN_LABELS.s,
    v: () => TOKEN_LABELS.v,
  } satisfies Readonly<Record<KeyboardShortcutToken, () => string>>
  return labels[token]()
}

const alwaysActive = () => true

const highestPriorityRegistration = (
  registrations: readonly KeyboardShortcutRegistration[],
  event: KeyboardEvent,
): Option.Option<KeyboardShortcutRegistration> => {
  let active = Option.none<KeyboardShortcutRegistration>()
  for (const registration of registrations) {
    if (!registration.when(event)) continue
    if (outranks(registration, active)) active = Option.some(registration)
  }
  return active
}

const outranks = (
  candidate: KeyboardShortcutRegistration,
  current: Option.Option<KeyboardShortcutRegistration>,
) =>
  Option.match(current, {
    onNone: () => true,
    onSome: (registered) =>
      candidate.priority > registered.priority ||
      (candidate.priority === registered.priority && candidate.sequence > registered.sequence),
  })

const matchesBinding = (event: KeyboardEvent, binding: readonly KeyboardShortcutToken[]) => {
  const expectsModifier = binding.includes("mod")
  const expectsShift = binding.includes("shift")
  let primaryModifier = event.ctrlKey && !event.metaKey
  if (isMacPlatform()) primaryModifier = event.metaKey && !event.ctrlKey
  if (event.altKey || event.shiftKey !== expectsShift) return false
  if (expectsModifier && !primaryModifier) return false
  if (!expectsModifier && (event.metaKey || event.ctrlKey)) return false
  const key = Option.fromNullishOr(binding.find((token) => token !== "mod" && token !== "shift"))
  return Option.exists(key, (token) => {
    let expectedKey: string = token
    if (token === "slash") expectedKey = "/"
    if (token === "digit") return /^[1-9]$/.test(event.key)
    return event.key.toLowerCase() === expectedKey
  })
}
