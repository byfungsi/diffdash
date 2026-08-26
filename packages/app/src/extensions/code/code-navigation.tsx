import { CodeLineChangeRange } from "@diffdash/domain/code-line-change"
import {
  CodeWorkspaceTarget,
  ProjectHeadCodeWorkspaceTarget,
} from "@diffdash/domain/code-workspace"
import { DiffFileStatus } from "@diffdash/domain/diff"
import type { ReviewSnapshotFileInventory } from "@diffdash/domain/review-context"
import { LanguageRange } from "@diffdash/domain/language"
import { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { Equal, HashMap, Option, Schema } from "effect"
import { createContext, type ReactNode, use, useLayoutEffect, useRef, useState } from "react"

import type { LanguageNavigationDestination } from "@/source-surface/language-navigation-capability"
import {
  makeBoundedHashMapEntriesSchema,
  makeExtensionNavigationStateCodec,
} from "../navigation-state-schema"
import {
  useProjectNavigationRestorationListener,
  useProjectNavigationRestoreHandler,
} from "../project-navigation-runtime"
import type { EncodedExtensionLocation, ProjectNavigationContribution } from "../extension-registry"
import {
  TrustedExtensionContributionId,
  type TrustedExtensionRegistrationToken,
} from "../extension-registry"

const FileStatuses = makeBoundedHashMapEntriesSchema(RepositoryRelativePath, DiffFileStatus, 5_000)

const LineChanges = makeBoundedHashMapEntriesSchema(
  RepositoryRelativePath,
  Schema.Array(CodeLineChangeRange).pipe(Schema.check(Schema.isMaxLength(5_000))),
  5_000,
)

const CodeNavigationState = Schema.Struct({
  target: CodeWorkspaceTarget,
  path: Schema.OptionFromNullOr(RepositoryRelativePath),
  revealRange: Schema.OptionFromNullOr(LanguageRange),
  fileStatuses: FileStatuses,
  lineChanges: LineChanges,
})
const CodeNavigationStateCodec = makeExtensionNavigationStateCodec(CodeNavigationState)

/** Decoded navigation state owned by the Code extension. */
export type CodeNavigationState = typeof CodeNavigationState.Type

/** Inputs accepted when creating one Code history payload. */
export type CodeNavigationStateInput = CodeNavigationState

/** One definition reveal restored from Code navigation history. */
export interface CodeDefinitionNavigation {
  readonly id: number
  readonly path: RepositoryRelativePath
  readonly range: LanguageRange
}

/** Code-owned workspace state and opaque history mutations used by the workbench. */
export interface CodeNavigationController {
  readonly target: Option.Option<CodeNavigationState["target"]>
  readonly path: Option.Option<RepositoryRelativePath>
  readonly fileStatuses: HashMap.HashMap<RepositoryRelativePath, typeof DiffFileStatus.Type>
  readonly lineChanges: HashMap.HashMap<RepositoryRelativePath, readonly CodeLineChangeRange[]>
  readonly definitionNavigation: Option.Option<CodeDefinitionNavigation>
  readonly workspaceMounted: boolean
  readonly clearCodeNavigation: () => void
  readonly handleDefinitionNavigation: (id: number) => void
  readonly encodeCodeLocation: (input: CodeNavigationStateInput) => EncodedExtensionLocation
  readonly selectCodePath: (
    state: EncodedExtensionLocation,
    path: Option.Option<RepositoryRelativePath>,
  ) => EncodedExtensionLocation
  readonly revealCodeOrigin: (
    state: EncodedExtensionLocation,
    range: LanguageRange,
  ) => EncodedExtensionLocation
  readonly navigateCodeDefinition: (
    state: EncodedExtensionLocation,
    destination: LanguageNavigationDestination,
  ) => EncodedExtensionLocation
}

/** Code state callback used by owner-level restoration tests and adapters. */
export interface CodeNavigationRestoreHost {
  readonly restore: (state: CodeNavigationState) => void
}

/** Stable identity for Code history encoding and restoration. */
export const CODE_NAVIGATION_ID = TrustedExtensionContributionId.make(
  "diffdash.builtin.code.navigation",
)

/** Encodes Code-owned location state for the generic global history. */
export const encodeCodeNavigationState = (
  input: CodeNavigationStateInput,
): EncodedExtensionLocation => CodeNavigationStateCodec.encode(input)

/** Creates the default Code destination for a project without exposing Code payload fields. */
export const createDefaultCodeNavigationState = (
  projectId: CodeNavigationState["target"]["projectId"],
): EncodedExtensionLocation =>
  encodeCodeNavigationState({
    target: ProjectHeadCodeWorkspaceTarget.make({ projectId }),
    path: Option.none(),
    revealRange: Option.none(),
    fileStatuses: HashMap.empty(),
    lineChanges: HashMap.empty(),
  })

/** Creates a Code file destination from semantic review source inputs. */
export const createCodeFileNavigationState = ({
  files,
  lineChanges = HashMap.empty(),
  path,
  projectId,
  revealRange,
  target = ProjectHeadCodeWorkspaceTarget.make({ projectId }),
}: {
  readonly projectId: CodeNavigationState["target"]["projectId"]
  readonly path: RepositoryRelativePath
  readonly revealRange: Option.Option<LanguageRange>
  readonly target?: CodeWorkspaceTarget
  readonly files?: readonly ReviewSnapshotFileInventory[]
  readonly lineChanges?: HashMap.HashMap<RepositoryRelativePath, readonly CodeLineChangeRange[]>
}): EncodedExtensionLocation =>
  encodeCodeNavigationState({
    target,
    path: Option.some(path),
    revealRange,
    fileStatuses: HashMap.fromIterable(
      (files ?? [])
        .filter((file) => file.status !== "deleted")
        .map((file) => [file.path, file.status] as const),
    ),
    lineChanges,
  })

/** Decodes Code-owned location state after registry validation. */
export const decodeCodeNavigationState = (state: EncodedExtensionLocation): CodeNavigationState =>
  CodeNavigationStateCodec.decode(state)

/** Restores decoded Code state through its owner callback. */
export const restoreCodeNavigationState = (
  state: EncodedExtensionLocation,
  host: CodeNavigationRestoreHost,
): void => host.restore(decodeCodeNavigationState(state))

/** Selects a Code path while preserving the remaining owner state. */
export const selectCodeNavigationPath = (
  state: EncodedExtensionLocation,
  path: Option.Option<RepositoryRelativePath>,
): EncodedExtensionLocation =>
  encodeCodeNavigationState({
    ...decodeCodeNavigationState(state),
    path,
    revealRange: Option.none(),
  })

/** Adds a definition origin range without adding a second history destination. */
export const revealCodeNavigationOrigin = (
  state: EncodedExtensionLocation,
  range: LanguageRange,
): EncodedExtensionLocation =>
  encodeCodeNavigationState({
    ...decodeCodeNavigationState(state),
    revealRange: Option.some(range),
  })

/** Navigates to a definition target while preserving the Code workspace identity. */
export const navigateCodeNavigationDefinition = (
  state: EncodedExtensionLocation,
  destination: LanguageNavigationDestination,
): EncodedExtensionLocation =>
  encodeCodeNavigationState({
    ...decodeCodeNavigationState(state),
    path: Option.some(destination.location.target.path),
    revealRange: Option.some(destination.location.targetSelectionRange),
  })

const CodeNavigationContext = createContext<CodeNavigationController | null>(null)

/** Returns Code-owned workspace state and opaque navigation mutations. */
export const useCodeNavigationController = (): CodeNavigationController => {
  const controller = use(CodeNavigationContext)
  if (controller === null) throw new Error("CodeNavigationProvider is unavailable")
  return controller
}

/** Owns Code navigation state and restores opaque Code history while registered. */
export const CodeNavigationProvider = ({
  active,
  children,
  registrationToken,
}: {
  readonly active: boolean
  readonly children: ReactNode
  readonly registrationToken: TrustedExtensionRegistrationToken
}) => {
  const [target, setTarget] = useState<Option.Option<CodeNavigationState["target"]>>(Option.none)
  const [path, setPath] = useState<Option.Option<RepositoryRelativePath>>(Option.none)
  const [fileStatuses, setFileStatuses] = useState<
    HashMap.HashMap<RepositoryRelativePath, typeof DiffFileStatus.Type>
  >(HashMap.empty)
  const [lineChanges, setLineChanges] = useState<
    HashMap.HashMap<RepositoryRelativePath, readonly CodeLineChangeRange[]>
  >(HashMap.empty)
  const [definitionNavigation, setDefinitionNavigation] = useState<
    Option.Option<CodeDefinitionNavigation>
  >(Option.none)
  const [workspaceMounted, setWorkspaceMounted] = useState(false)
  const definitionNavigationSequenceRef = useRef(0)
  const clearCodeNavigation = () => {
    setTarget(Option.none())
    setPath(Option.none())
    setFileStatuses(HashMap.empty())
    setLineChanges(HashMap.empty())
    setDefinitionNavigation(Option.none())
    setWorkspaceMounted(false)
  }
  useLayoutEffect(() => {
    if (!active) clearCodeNavigation()
  }, [active, registrationToken])
  useProjectNavigationRestorationListener(active, (entry) => {
    if (
      entry.surface === "review" &&
      !Option.exists(target, (currentTarget) => currentTarget.projectId === entry.repo.id)
    ) {
      setTarget(Option.some(ProjectHeadCodeWorkspaceTarget.make({ projectId: entry.repo.id })))
      setPath(Option.none())
      setFileStatuses(HashMap.empty())
      setLineChanges(HashMap.empty())
      setDefinitionNavigation(Option.none())
      setWorkspaceMounted(false)
    }
  })
  useProjectNavigationRestoreHandler(
    active,
    CODE_NAVIGATION_ID,
    registrationToken,
    (state) => {
      restoreCodeNavigationState(state, {
        restore: (restored) => {
          setTarget(Option.some(restored.target))
          setPath(restored.path)
          setFileStatuses(restored.fileStatuses)
          setLineChanges(restored.lineChanges)
          setWorkspaceMounted(true)
          setDefinitionNavigation(
            Option.flatMap(restored.path, (restoredPath) =>
              Option.map(restored.revealRange, (range) => {
                const id = definitionNavigationSequenceRef.current + 1
                definitionNavigationSequenceRef.current = id
                return { id, path: restoredPath, range }
              }),
            ),
          )
        },
      })
    },
    clearCodeNavigation,
  )
  const controller: CodeNavigationController = {
    target,
    path,
    fileStatuses,
    lineChanges,
    definitionNavigation,
    workspaceMounted,
    clearCodeNavigation,
    handleDefinitionNavigation: (id) =>
      setDefinitionNavigation((current) =>
        Option.filter(current, (navigation) => navigation.id !== id),
      ),
    encodeCodeLocation: encodeCodeNavigationState,
    selectCodePath: selectCodeNavigationPath,
    revealCodeOrigin: revealCodeNavigationOrigin,
    navigateCodeDefinition: navigateCodeNavigationDefinition,
  }
  return <CodeNavigationContext value={controller}>{children}</CodeNavigationContext>
}

/** Code navigation codec registered atomically with the Code surface. */
export const codeNavigationContribution: ProjectNavigationContribution = {
  id: CODE_NAVIGATION_ID,
  order: 200,
  surface: "code",
  component: CodeNavigationProvider,
  createDefaultState: (repo) => createDefaultCodeNavigationState(repo.id),
  isValidState: CodeNavigationStateCodec.isValid,
  sameState: (left, right) => {
    if (
      !codeNavigationContribution.isValidState(left) ||
      !codeNavigationContribution.isValidState(right)
    )
      return false
    const leftState = decodeCodeNavigationState(left)
    const rightState = decodeCodeNavigationState(right)
    return (
      Equal.equals(leftState.target, rightState.target) &&
      Equal.equals(leftState.path, rightState.path) &&
      Equal.equals(leftState.revealRange, rightState.revealRange)
    )
  },
}
