import type { ProjectWorkspaceActivityId } from "@diffdash/domain/project-workspace"
import {
  ProjectWorkspaceNavigationContributionId,
  type ProjectWorkspaceNavigationLocation,
  ProjectWorkspaceSurface,
  type ProjectWorkspaceSurface as ProjectWorkspaceSurfaceType,
  ProjectWorkspaceActivitySurfacePolicy,
} from "@diffdash/domain/project-workspace"
import type { ParsedDiffFile } from "@diffdash/domain/diff"
import type { ReviewProjectId, ReviewRevision } from "@diffdash/domain/review-identity"
import type { GitCommitSha } from "@diffdash/domain/repository-comparison"
import type { Repo, RepositoryCheckoutPath } from "@diffdash/domain/repository"
import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import type {
  ReviewThreadAnchor,
  ReviewThreadDetails,
  ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import { Array as EffectArray, HashMap, HashSet, Option, Order, Result, Schema } from "effect"
import type { ComponentType, ReactNode } from "react"
import { HomeGlobalDestination } from "@/home/home-global-destination"

const trustedExtensionIdPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){2,}$/u

/** Stable lowercase namespace identifying one trusted renderer extension. */
export const TrustedExtensionId = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(128)),
  Schema.check(
    Schema.makeFilter((value) => trustedExtensionIdPattern.test(value), {
      message: "Expected a namespaced trusted extension ID",
    }),
  ),
  Schema.brand("TrustedExtensionId"),
)

/** Stable lowercase namespace identifying one trusted renderer extension. */
export type TrustedExtensionId = typeof TrustedExtensionId.Type

/** Stable lowercase namespace identifying one renderer contribution. */
export const TrustedExtensionContributionId = ProjectWorkspaceNavigationContributionId

/** Stable lowercase namespace identifying one renderer contribution. */
export type TrustedExtensionContributionId = typeof TrustedExtensionContributionId.Type

let nextRegistrationTokenReactKey = 0

/** Identity token distinguishing successive registrations of the same trusted extension. */
export class TrustedExtensionRegistrationToken {
  readonly reactKey = (nextRegistrationTokenReactKey += 1)
}

/** Stable domain identity of the project surface hosting an activity pane. */
export interface ProjectSurfaceLocation {
  readonly projectId: ReviewProjectId
  readonly surface: ProjectWorkspaceSurfaceType
}

/** Activity-neutral controls exposed by a project surface pane host. */
export interface ProjectActivityPaneHostControls {
  readonly contextOpen: boolean
  readonly detailOpen: boolean
  readonly contextActions: ReactNode
  readonly openContext: () => void
  readonly openDetail: () => void
  readonly closeContext: () => void
  readonly closeDetail: () => void
  readonly showMain: () => void
}

/** Generic surface identity and pane controls supplied to a trusted project activity. */
export interface ProjectActivityPaneProps {
  readonly location: ProjectSurfaceLocation
  readonly paneHost: ProjectActivityPaneHostControls
}

/** Visual contract owned by a project activity and rendered by the shared activity host. */
export interface ProjectActivityIconProps {
  readonly className?: string
}

/** One identified trusted component rendered in an activity's context pane. */
export interface ProjectActivityContextPaneContribution {
  readonly id: TrustedExtensionContributionId
  readonly order: number
  readonly component: ComponentType<ProjectActivityPaneProps>
}

/** Activity main pane replacing the surface default without receiving its rendered base. */
export interface ProjectActivityReplacingMainPaneContribution {
  readonly id: TrustedExtensionContributionId
  readonly order: number
  readonly mode: "replace"
  readonly component: ComponentType<ProjectActivityPaneProps>
}

/** Activity main pane decorating and preserving the rendered surface default. */
export interface ProjectActivityDecoratingMainPaneContribution {
  readonly id: TrustedExtensionContributionId
  readonly order: number
  readonly mode: "decorate"
  readonly component: ComponentType<ProjectActivityMainPaneProps>
}

/** Main-pane contribution with explicit replacement or decoration semantics. */
export type ProjectActivityMainPaneContribution =
  | ProjectActivityReplacingMainPaneContribution
  | ProjectActivityDecoratingMainPaneContribution

/** Semantic activity context plus the surface owner's default main pane. */
export type ProjectActivityMainPaneProps = ProjectActivityPaneProps & {
  readonly baseMain: ReactNode
}

/** The single main-pane implementation owned by one complete project surface. */
export interface ProjectSurfaceDefaultMainPaneContribution {
  readonly id: TrustedExtensionContributionId
  readonly order: number
  readonly component: ComponentType<{ readonly baseMain: ReactNode }>
}

/** One identified trusted component rendered in an activity's detail pane. */
export interface ProjectActivityDetailPaneContribution {
  readonly id: TrustedExtensionContributionId
  readonly order: number
  readonly component: ComponentType<ProjectActivityPaneProps>
}

/** Structured workbench panes owned by one trusted project activity. */
export interface ProjectActivityPaneSlots {
  readonly contextPane?: ProjectActivityContextPaneContribution
  readonly mainPane?: ProjectActivityMainPaneContribution
  readonly detailPane?: ProjectActivityDetailPaneContribution
}

/** Trusted project activity metadata rendered by the shared workspace host. */
export interface ProjectActivityContribution {
  readonly id: ProjectWorkspaceActivityId
  readonly label: string
  readonly icon: ComponentType<ProjectActivityIconProps>
  readonly order: number
  readonly supportedSurfaces: readonly ProjectWorkspaceSurfaceType[]
  readonly defaultForSurfaces?: readonly ProjectWorkspaceSurfaceType[]
  readonly surfacePolicy: ProjectWorkspaceActivitySurfacePolicy
  readonly slots?: ProjectActivityPaneSlots
}

/** One trusted extension component owning a complete project source surface. */
export interface ProjectSurfaceContribution {
  readonly id: TrustedExtensionContributionId
  readonly order: number
  readonly surface: ProjectWorkspaceSurfaceType
  readonly defaultActivityId: ProjectWorkspaceActivityId
  readonly defaultMainPane: ProjectSurfaceDefaultMainPaneContribution
  readonly keepMountedAfterVisit?: boolean
  readonly component: ComponentType
}

/** One owner-scoped lifecycle provider mounted around a registered project surface. */
export interface ProjectSurfaceProviderContribution {
  readonly id: TrustedExtensionContributionId
  readonly order: number
  readonly surface: ProjectWorkspaceSurfaceType
  readonly component: ComponentType<{
    readonly active: boolean
    readonly registrationToken: TrustedExtensionRegistrationToken
    readonly children: ReactNode
  }>
}

/** Opaque structured-clone-safe state retained by the global navigation timeline. */
export type EncodedExtensionLocation = ProjectWorkspaceNavigationLocation

/** Generic project-opening and history controls supplied to a global destination owner. */
export interface GlobalNavigationHostControls {
  readonly openProject: (repo: Repo) => Promise<void>
  readonly openProjectDirectory: (directory: string) => Promise<void>
  readonly removeProjectHistory: (projectId: ReviewProjectId) => void
}

/** Generic state and host controls supplied to an application-level destination owner. */
export interface GlobalNavigationDestinationProps {
  readonly state: EncodedExtensionLocation
  readonly host: GlobalNavigationHostControls
}

/** Owner-defined application-level destination outside a project workspace. */
export interface GlobalNavigationContribution {
  readonly id: TrustedExtensionContributionId
  readonly order: number
  readonly initialState: EncodedExtensionLocation
  readonly isValidState: (state: EncodedExtensionLocation) => boolean
  readonly sameState: (left: EncodedExtensionLocation, right: EncodedExtensionLocation) => boolean
  readonly component: ComponentType<GlobalNavigationDestinationProps>
}

/** Generic application-level destination retained without interpreting owner state. */
export interface GlobalNavigationEntry {
  readonly kind: "global"
  readonly contributionId: TrustedExtensionContributionId
  readonly registrationToken: TrustedExtensionRegistrationToken
  readonly state: EncodedExtensionLocation
}

/** Owner-produced project destination applied by the shell without decoding extension state. */
export interface ProjectNavigationResult {
  readonly repo: Repo
  readonly contributionId: TrustedExtensionContributionId
  readonly registrationToken: TrustedExtensionRegistrationToken
  readonly activeSurface: ProjectWorkspaceSurfaceType
  readonly activeActivity: ProjectWorkspaceActivityId
  readonly activityRegistrationToken: TrustedExtensionRegistrationToken
  readonly state: EncodedExtensionLocation
  readonly notice: Option.Option<string>
}

/** Owner-provided identity and equality semantics for one project navigation destination. */
export interface ProjectNavigationContribution {
  readonly id: TrustedExtensionContributionId
  readonly order: number
  readonly surface: ProjectWorkspaceSurfaceType
  readonly component: ComponentType<{
    readonly active: boolean
    readonly registrationToken: TrustedExtensionRegistrationToken
    readonly children: ReactNode
  }>
  readonly createDefaultState: (repo: Repo) => EncodedExtensionLocation
  readonly isValidState: (state: EncodedExtensionLocation) => boolean
  readonly sameState: (left: EncodedExtensionLocation, right: EncodedExtensionLocation) => boolean
}

/** Generic project destination retained by the host without interpreting extension state. */
export interface ProjectNavigationEntry {
  readonly kind: "project"
  readonly contributionId: TrustedExtensionContributionId
  readonly registrationToken: TrustedExtensionRegistrationToken
  readonly activityId: ProjectWorkspaceActivityId
  readonly activityRegistrationToken: TrustedExtensionRegistrationToken
  readonly surface: ProjectWorkspaceSurfaceType
  readonly repo: Repo
  readonly state: EncodedExtensionLocation
}

/** Active Code file identity supplied to trusted source contributions. */
export interface CodeSourceContext {
  readonly projectId: ReviewProjectId
  readonly workspaceRevision: ReviewRevision
  readonly gitRevision: Option.Option<GitCommitSha>
  readonly path: RepositoryRelativePath
}

/** Exact semantic Code line supplied to an ordered source action. */
export interface CodeSourceLineTarget extends CodeSourceContext {
  readonly lineNumber: number
  readonly lineContent: string
}

/** Output registered by one mounted trusted Code source contribution. */
export interface CodeSourceContributionOutput {
  readonly handleLineAction: (target: CodeSourceLineTarget) => boolean
  readonly annotation: Option.Option<{
    readonly lineNumber: number
    readonly render: () => ReactNode
  }>
}

/** Project context supplied to one trusted Code source contribution. */
export interface CodeSourceContributionProps {
  readonly source: CodeSourceContext
}

/** One trusted component mounted for each active Code source host. */
export interface CodeSourceContribution {
  readonly id: TrustedExtensionContributionId
  readonly order: number
  readonly component: ComponentType<CodeSourceContributionProps>
}

/** Review context supplied to one trusted review diff contribution. */
export interface ReviewDiffContributionProps {
  readonly projectId: ReviewProjectId
  readonly target: ReviewThreadTarget
  readonly baseRevision: ReviewRevision
  readonly headRevision: ReviewRevision
}

/** Generic annotation projected by a review contribution into the host-owned diff renderer. */
export interface ReviewDiffContributionAnnotation {
  readonly lineNumber: number
  readonly side: "additions" | "deletions"
  readonly render: () => ReactNode
}

/** Live semantic output registered by one mounted review diff contribution. */
export interface ReviewDiffContributionOutput {
  readonly activeLineAnchor: Option.Option<ReviewThreadAnchor>
  readonly details: readonly ReviewThreadDetails[]
  readonly annotations: (
    file: ParsedDiffFile,
    navigationAnchor: Option.Option<ReviewThreadAnchor>,
  ) => readonly ReviewDiffContributionAnnotation[]
  readonly activateLine: (
    file: ParsedDiffFile,
    side: "additions" | "deletions",
    lineNumber: number,
  ) => boolean
  readonly annotationsRendered: (card: HTMLElement) => void
}

/** One trusted component mounted for the active review diff host. */
export interface ReviewDiffContribution {
  readonly id: TrustedExtensionContributionId
  readonly order: number
  readonly component: ComponentType<ReviewDiffContributionProps>
}

/** Project scope supplied to one trusted extension state provider. */
export interface TrustedProjectProviderProps {
  readonly active: boolean
  readonly registrationToken: TrustedExtensionRegistrationToken
  readonly projectId: ReviewProjectId | null
  readonly directory: RepositoryCheckoutPath | null
  readonly children: ReactNode
}

/** One trusted project-scoped state provider composed around the workbench. */
export interface TrustedProjectProviderContribution {
  readonly id: TrustedExtensionContributionId
  readonly order: number
  readonly component: ComponentType<TrustedProjectProviderProps>
}

/** Registration state supplied to one retained project-opening provider slot. */
export interface ProjectOpeningProviderProps {
  readonly active: boolean
  readonly registrationToken: TrustedExtensionRegistrationToken
  readonly children: ReactNode
}

/** One owner-scoped provider of project opening, restoration, and palette capabilities. */
export interface ProjectOpeningProviderContribution {
  readonly id: TrustedExtensionContributionId
  readonly order: number
  readonly component: ComponentType<ProjectOpeningProviderProps>
}

/** Project context supplied to one optional trusted titlebar action. */
export interface TrustedTitlebarActionProps {
  readonly projectId: ReviewProjectId | null
}

/** One optional trusted component rendered in the workbench titlebar. */
export interface TrustedTitlebarActionContribution {
  readonly id: TrustedExtensionContributionId
  readonly order: number
  readonly component: ComponentType<TrustedTitlebarActionProps>
}

/**
 * Static definition of one trusted renderer extension composed with the application bundle.
 * This React-bearing contract is private renderer infrastructure, not a public extension SDK.
 */
export interface TrustedBuiltInExtension {
  readonly id: TrustedExtensionId
  readonly globalNavigation?: readonly GlobalNavigationContribution[]
  readonly projectActivities?: readonly ProjectActivityContribution[]
  readonly projectSurfaces?: readonly ProjectSurfaceContribution[]
  readonly projectSurfaceProviders?: readonly ProjectSurfaceProviderContribution[]
  readonly projectNavigation?: readonly ProjectNavigationContribution[]
  readonly codeSourceContributions?: readonly CodeSourceContribution[]
  readonly reviewDiffContributions?: readonly ReviewDiffContribution[]
  readonly projectProviders?: readonly TrustedProjectProviderContribution[]
  readonly projectOpeningProviders?: readonly ProjectOpeningProviderContribution[]
  readonly titlebarActions?: readonly TrustedTitlebarActionContribution[]
}

/** Registered contribution annotated with the extension that owns its lifecycle. */
export type OwnedExtensionContribution<Contribution> = Contribution & {
  readonly ownerExtensionId: TrustedExtensionId
  readonly ownerRegistrationToken: TrustedExtensionRegistrationToken
}

/** Immutable registry view consumed by project and source-surface hosts. */
export interface TrustedExtensionRegistrySnapshot {
  readonly globalNavigation: readonly OwnedExtensionContribution<GlobalNavigationContribution>[]
  readonly projectActivities: readonly OwnedExtensionContribution<ProjectActivityContribution>[]
  readonly projectSurfaces: readonly OwnedExtensionContribution<ProjectSurfaceContribution>[]
  readonly projectSurfaceProviders: readonly OwnedExtensionContribution<ProjectSurfaceProviderContribution>[]
  readonly projectNavigation: readonly OwnedExtensionContribution<ProjectNavigationContribution>[]
  readonly codeSourceContributions: readonly OwnedExtensionContribution<CodeSourceContribution>[]
  readonly reviewDiffContributions: readonly OwnedExtensionContribution<ReviewDiffContribution>[]
  readonly projectProviders: readonly OwnedExtensionContribution<TrustedProjectProviderContribution>[]
  readonly projectOpeningProviders: readonly OwnedExtensionContribution<ProjectOpeningProviderContribution>[]
  readonly titlebarActions: readonly OwnedExtensionContribution<TrustedTitlebarActionContribution>[]
}

/** Typed registration failure for duplicate trusted extension ownership. */
export class DuplicateTrustedExtensionError extends Schema.TaggedError<DuplicateTrustedExtensionError>()(
  "DuplicateTrustedExtensionError",
  {
    extensionId: TrustedExtensionId,
    message: Schema.String,
  },
) {}

/** Typed registration failure for duplicate contribution ownership across any renderer slot. */
export class DuplicateTrustedContributionError extends Schema.TaggedError<DuplicateTrustedContributionError>()(
  "DuplicateTrustedContributionError",
  {
    extensionId: TrustedExtensionId,
    contributionId: Schema.String,
    message: Schema.String,
  },
) {}

/** Typed registration failure for more than one owner of a project source surface. */
export class DuplicateTrustedProjectSurfaceError extends Schema.TaggedError<DuplicateTrustedProjectSurfaceError>()(
  "DuplicateTrustedProjectSurfaceError",
  {
    extensionId: TrustedExtensionId,
    surface: ProjectWorkspaceSurface,
    message: Schema.String,
  },
) {}

/** Typed registration failure for an incomplete or inconsistent project surface composition. */
export class InvalidTrustedProjectCompositionError extends Schema.TaggedError<InvalidTrustedProjectCompositionError>()(
  "InvalidTrustedProjectCompositionError",
  {
    extensionId: TrustedExtensionId,
    surface: ProjectWorkspaceSurface,
    reason: Schema.Literals([
      "activity-targets-unowned-surface",
      "default-activity-missing",
      "default-activity-unsupported",
      "default-marker-mismatch",
      "default-marker-unsupported",
      "invalid-main-pane-mode",
      "missing-navigation",
      "duplicate-navigation",
      "navigation-targets-unowned-surface",
    ]),
    message: Schema.String,
  },
) {}

/** Expected failure from trusted renderer extension registration. */
export type TrustedExtensionRegistrationError =
  | DuplicateTrustedExtensionError
  | DuplicateTrustedContributionError
  | DuplicateTrustedProjectSurfaceError
  | InvalidTrustedProjectCompositionError

interface RegisteredExtension {
  readonly definition: TrustedBuiltInExtension
  readonly token: TrustedExtensionRegistrationToken
}

/** Stable contribution ID for the required host-owned Home destination. */
export const REQUIRED_HOME_NAVIGATION_ID = TrustedExtensionContributionId.make(
  "diffdash.host.navigation.home",
)

const REQUIRED_HOME_EXTENSION_ID = TrustedExtensionId.make("diffdash.host.navigation")
const requiredHomeRegistrationToken = new TrustedExtensionRegistrationToken()
const REQUIRED_HOME_NAVIGATION: OwnedExtensionContribution<GlobalNavigationContribution> =
  Object.freeze({
    id: REQUIRED_HOME_NAVIGATION_ID,
    order: Number.MIN_SAFE_INTEGER,
    initialState: null,
    isValidState: (state: EncodedExtensionLocation) => state === null,
    sameState: (left: EncodedExtensionLocation, right: EncodedExtensionLocation) =>
      left === null && right === null,
    component: HomeGlobalDestination,
    ownerExtensionId: REQUIRED_HOME_EXTENSION_ID,
    ownerRegistrationToken: requiredHomeRegistrationToken,
  })

/** Creates the guaranteed global navigation fallback owned by the host. */
export const makeRequiredGlobalNavigationFallback = (): GlobalNavigationEntry => ({
  kind: "global",
  contributionId: REQUIRED_HOME_NAVIGATION.id,
  registrationToken: REQUIRED_HOME_NAVIGATION.ownerRegistrationToken,
  state: REQUIRED_HOME_NAVIGATION.initialState,
})

const EMPTY_REGISTRY_SNAPSHOT: TrustedExtensionRegistrySnapshot = Object.freeze({
  globalNavigation: Object.freeze([REQUIRED_HOME_NAVIGATION]),
  projectActivities: Object.freeze([]),
  projectSurfaces: Object.freeze([]),
  projectSurfaceProviders: Object.freeze([]),
  projectNavigation: Object.freeze([]),
  codeSourceContributions: Object.freeze([]),
  reviewDiffContributions: Object.freeze([]),
  projectProviders: Object.freeze([]),
  projectOpeningProviders: Object.freeze([]),
  titlebarActions: Object.freeze([]),
})

/** Synchronous registry for statically trusted renderer extensions bundled with DiffDash. */
export class TrustedExtensionRegistry {
  private extensions = HashMap.empty<TrustedExtensionId, RegisteredExtension>()
  private readonly listeners = new Set<() => void>()
  private currentSnapshot: TrustedExtensionRegistrySnapshot = EMPTY_REGISTRY_SNAPSHOT

  /** Returns the stable immutable snapshot for the current registration generation. */
  readonly snapshot = (): TrustedExtensionRegistrySnapshot => this.currentSnapshot

  /** Subscribes a host to registry generation changes. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Atomically unregisters every contribution owned by one trusted extension. */
  readonly unregister = (extensionId: TrustedExtensionId): boolean => {
    if (!HashMap.has(this.extensions, extensionId)) return false
    this.extensions = HashMap.remove(this.extensions, extensionId)
    this.refreshSnapshot()
    return true
  }

  /** Atomically registers one extension and returns an ownership-safe idempotent disposer. */
  register(
    extension: TrustedBuiltInExtension,
  ): Result.Result<() => void, TrustedExtensionRegistrationError> {
    if (extension.id === REQUIRED_HOME_EXTENSION_ID || HashMap.has(this.extensions, extension.id)) {
      return Result.fail(
        DuplicateTrustedExtensionError.make({
          extensionId: extension.id,
          message: `Trusted extension already registered: ${extension.id}`,
        }),
      )
    }

    const contributionFailure = this.findContributionIdConflict(extension)
    if (Option.isSome(contributionFailure)) return Result.fail(contributionFailure.value)
    const surfaceFailure = this.findProjectSurfaceConflict(extension)
    if (Option.isSome(surfaceFailure)) return Result.fail(surfaceFailure.value)

    const compositionFailure = this.findProjectCompositionFailure(
      [...Array.from(HashMap.values(this.extensions), ({ definition }) => definition), extension],
      false,
    )
    if (Option.isSome(compositionFailure)) return Result.fail(compositionFailure.value)

    const definition = freezeExtensionDefinition(extension)
    const registration = { definition, token: new TrustedExtensionRegistrationToken() }
    this.extensions = HashMap.set(this.extensions, definition.id, registration)
    this.refreshSnapshot()

    return Result.succeed(() => {
      const currentRegistration = HashMap.get(this.extensions, definition.id)
      if (
        Option.isNone(currentRegistration) ||
        currentRegistration.value.token !== registration.token
      )
        return
      this.unregister(definition.id)
    })
  }

  /** Atomically registers a complete requested extension set for cold composition. */
  registerAll(
    extensions: readonly TrustedBuiltInExtension[],
  ): Result.Result<void, TrustedExtensionRegistrationError> {
    let registrations = this.extensions
    for (const extension of extensions) {
      if (extension.id === REQUIRED_HOME_EXTENSION_ID || HashMap.has(registrations, extension.id)) {
        return Result.fail(
          DuplicateTrustedExtensionError.make({
            extensionId: extension.id,
            message: `Trusted extension already registered: ${extension.id}`,
          }),
        )
      }

      const contributionFailure = this.findContributionIdConflict(extension, registrations)
      if (Option.isSome(contributionFailure)) return Result.fail(contributionFailure.value)
      const surfaceFailure = this.findProjectSurfaceConflict(extension, registrations)
      if (Option.isSome(surfaceFailure)) return Result.fail(surfaceFailure.value)

      const definition = freezeExtensionDefinition(extension)
      registrations = HashMap.set(registrations, definition.id, {
        definition,
        token: new TrustedExtensionRegistrationToken(),
      })
    }

    const compositionFailure = this.findProjectCompositionFailure(
      Array.from(HashMap.values(registrations), ({ definition }) => definition),
      true,
    )
    if (Option.isSome(compositionFailure)) return Result.fail(compositionFailure.value)

    this.extensions = registrations
    this.refreshSnapshot()
    return Result.succeed(undefined)
  }

  private findContributionIdConflict(
    extension: TrustedBuiltInExtension,
    registrations: HashMap.HashMap<TrustedExtensionId, RegisteredExtension> = this.extensions,
  ): Option.Option<DuplicateTrustedContributionError> {
    const registeredIds = this.registeredContributionIds(registrations)
    let extensionIds = HashSet.empty<string>()
    for (const contribution of extensionContributions(extension)) {
      if (
        HashSet.has(registeredIds, contribution.id) ||
        HashSet.has(extensionIds, contribution.id)
      ) {
        return Option.some(
          DuplicateTrustedContributionError.make({
            extensionId: extension.id,
            contributionId: contribution.id,
            message: `Trusted extension contribution already registered: ${contribution.id}`,
          }),
        )
      }
      extensionIds = HashSet.add(extensionIds, contribution.id)
    }
    return Option.none()
  }

  private findProjectSurfaceConflict(
    extension: TrustedBuiltInExtension,
    registrations: HashMap.HashMap<TrustedExtensionId, RegisteredExtension> = this.extensions,
  ): Option.Option<DuplicateTrustedProjectSurfaceError> {
    const registeredSurfaces = HashSet.fromIterable(
      Array.from(HashMap.values(registrations)).flatMap(({ definition }) =>
        (definition.projectSurfaces ?? []).map(({ surface }) => surface),
      ),
    )
    let extensionSurfaces = HashSet.empty<ProjectWorkspaceSurfaceType>()
    for (const contribution of extension.projectSurfaces ?? []) {
      if (
        HashSet.has(registeredSurfaces, contribution.surface) ||
        HashSet.has(extensionSurfaces, contribution.surface)
      ) {
        return Option.some(
          DuplicateTrustedProjectSurfaceError.make({
            extensionId: extension.id,
            surface: contribution.surface,
            message: `Trusted project surface already registered: ${contribution.surface}`,
          }),
        )
      }
      extensionSurfaces = HashSet.add(extensionSurfaces, contribution.surface)
    }
    return Option.none()
  }

  private registeredContributionIds(
    registrations: HashMap.HashMap<TrustedExtensionId, RegisteredExtension>,
  ): HashSet.HashSet<string> {
    let ids: HashSet.HashSet<string> = HashSet.make(REQUIRED_HOME_NAVIGATION_ID)
    for (const registration of HashMap.values(registrations)) {
      for (const contribution of extensionContributions(registration.definition)) {
        ids = HashSet.add(ids, contribution.id)
      }
    }
    return ids
  }

  private findProjectCompositionFailure(
    definitions: readonly TrustedBuiltInExtension[],
    allowDormantContributions: boolean,
  ): Option.Option<InvalidTrustedProjectCompositionError> {
    const surfaces = definitions.flatMap((definition) =>
      (definition.projectSurfaces ?? []).map((surface) => ({ definition, surface })),
    )
    const activities = definitions.flatMap((definition) =>
      (definition.projectActivities ?? []).map((activity) => ({ definition, activity })),
    )
    const navigation = definitions.flatMap((definition) =>
      (definition.projectNavigation ?? []).map((contribution) => ({ definition, contribution })),
    )
    const ownedSurfaces = HashSet.fromIterable(surfaces.map(({ surface }) => surface.surface))

    for (const surface of ["review", "code"] as const) {
      const matchingNavigation = navigation.filter(
        ({ contribution }) => contribution.surface === surface,
      )
      if (matchingNavigation.length > 1) {
        const duplicate = matchingNavigation[1]
        if (duplicate !== undefined) {
          return Option.some(
            InvalidTrustedProjectCompositionError.make({
              extensionId: duplicate.definition.id,
              surface,
              reason: "duplicate-navigation",
              message: `Trusted project surface must have exactly one navigation contribution: ${surface}`,
            }),
          )
        }
      }
    }

    for (const { definition, activity } of activities) {
      const availableActivitySurface = activity.supportedSurfaces.find((surface) =>
        HashSet.has(ownedSurfaces, surface),
      )
      if (availableActivitySurface === undefined) {
        const surface = activity.supportedSurfaces[0]
        if (surface !== undefined && !allowDormantContributions) {
          return Option.some(
            InvalidTrustedProjectCompositionError.make({
              extensionId: definition.id,
              surface,
              reason: "activity-targets-unowned-surface",
              message: `Trusted project activity has no owned supported surface: ${activity.id}`,
            }),
          )
        }
      }
      for (const surface of activity.defaultForSurfaces ?? []) {
        if (!activity.supportedSurfaces.includes(surface)) {
          return Option.some(
            InvalidTrustedProjectCompositionError.make({
              extensionId: definition.id,
              surface,
              reason: "default-marker-unsupported",
              message: `Trusted project activity marks an unsupported default surface: ${activity.id} -> ${surface}`,
            }),
          )
        }
      }
      const mode = activity.slots?.mainPane?.mode
      if (mode !== undefined && mode !== "replace" && mode !== "decorate") {
        const surface = activity.supportedSurfaces[0]
        if (surface !== undefined) {
          return Option.some(
            InvalidTrustedProjectCompositionError.make({
              extensionId: definition.id,
              surface,
              reason: "invalid-main-pane-mode",
              message: `Trusted project activity main pane has an invalid mode: ${activity.id}`,
            }),
          )
        }
      }
    }

    for (const { definition, contribution } of navigation) {
      if (!HashSet.has(ownedSurfaces, contribution.surface) && !allowDormantContributions) {
        return Option.some(
          InvalidTrustedProjectCompositionError.make({
            extensionId: definition.id,
            surface: contribution.surface,
            reason: "navigation-targets-unowned-surface",
            message: `Trusted project navigation targets an unowned surface: ${contribution.id} -> ${contribution.surface}`,
          }),
        )
      }
    }

    for (const { definition, surface } of surfaces) {
      const defaultActivity = activities.find(
        ({ activity }) => activity.id === surface.defaultActivityId,
      )
      if (defaultActivity === undefined) {
        return Option.some(
          InvalidTrustedProjectCompositionError.make({
            extensionId: definition.id,
            surface: surface.surface,
            reason: "default-activity-missing",
            message: `Trusted project surface default activity is missing: ${surface.surface} -> ${surface.defaultActivityId}`,
          }),
        )
      }
      if (!defaultActivity.activity.supportedSurfaces.includes(surface.surface)) {
        return Option.some(
          InvalidTrustedProjectCompositionError.make({
            extensionId: definition.id,
            surface: surface.surface,
            reason: "default-activity-unsupported",
            message: `Trusted project surface default activity does not support its surface: ${surface.surface} -> ${surface.defaultActivityId}`,
          }),
        )
      }
      const markedDefaults = activities.filter(({ activity }) =>
        activity.defaultForSurfaces?.includes(surface.surface),
      )
      if (
        markedDefaults.length !== 1 ||
        markedDefaults[0]?.activity.id !== surface.defaultActivityId
      ) {
        return Option.some(
          InvalidTrustedProjectCompositionError.make({
            extensionId: definition.id,
            surface: surface.surface,
            reason: "default-marker-mismatch",
            message: `Trusted project surface must have exactly one matching default activity marker: ${surface.surface} -> ${surface.defaultActivityId}`,
          }),
        )
      }
      const matchingNavigation = navigation.filter(
        ({ definition: navigationOwner, contribution }) =>
          navigationOwner.id === definition.id && contribution.surface === surface.surface,
      )
      if (matchingNavigation.length !== 1) {
        return Option.some(
          InvalidTrustedProjectCompositionError.make({
            extensionId: definition.id,
            surface: surface.surface,
            reason: "missing-navigation",
            message: `Trusted project surface must own exactly one matching navigation contribution: ${surface.surface}`,
          }),
        )
      }
    }
    return Option.none()
  }

  private refreshSnapshot(): void {
    const extensions = Array.from(HashMap.values(this.extensions))
    const projectComposition = composeRegisteredProjectContributions(extensions)
    const availableSurfaces = HashSet.fromIterable(
      projectComposition.projectSurfaces.map(({ surface }) => surface),
    )
    const completeProjectExtensionIds = HashSet.fromIterable(
      extensions
        .filter(({ definition, token }) =>
          (definition.projectActivities ?? []).every((activity) =>
            projectComposition.projectActivities.some(
              (registered) =>
                registered.id === activity.id && registered.ownerRegistrationToken === token,
            ),
          ),
        )
        .map(({ definition }) => definition.id),
    )
    this.currentSnapshot = Object.freeze({
      globalNavigation: Object.freeze([
        REQUIRED_HOME_NAVIGATION,
        ...orderedContributions(
          extensions.flatMap(({ definition, token }) =>
            (definition.globalNavigation ?? []).map((contribution) =>
              ownContribution(definition.id, token, contribution),
            ),
          ),
        ),
      ]),
      projectActivities: Object.freeze(projectComposition.projectActivities),
      projectSurfaces: Object.freeze(projectComposition.projectSurfaces),
      projectSurfaceProviders: Object.freeze(projectComposition.projectSurfaceProviders),
      projectNavigation: Object.freeze(projectComposition.projectNavigation),
      codeSourceContributions: Object.freeze(
        orderedContributions(
          extensions.flatMap(({ definition, token }) =>
            HashSet.has(availableSurfaces, "code") &&
            HashSet.has(completeProjectExtensionIds, definition.id)
              ? (definition.codeSourceContributions ?? []).map((contribution) =>
                  ownContribution(definition.id, token, contribution),
                )
              : [],
          ),
        ),
      ),
      reviewDiffContributions: Object.freeze(
        orderedContributions(
          extensions.flatMap(({ definition, token }) =>
            HashSet.has(availableSurfaces, "review") &&
            HashSet.has(completeProjectExtensionIds, definition.id)
              ? (definition.reviewDiffContributions ?? []).map((contribution) =>
                  ownContribution(definition.id, token, contribution),
                )
              : [],
          ),
        ),
      ),
      projectProviders: Object.freeze(
        orderedContributions(
          extensions.flatMap(({ definition, token }) =>
            HashSet.has(completeProjectExtensionIds, definition.id)
              ? (definition.projectProviders ?? []).map((contribution) =>
                  ownContribution(definition.id, token, contribution),
                )
              : [],
          ),
        ),
      ),
      projectOpeningProviders: Object.freeze(
        orderedContributions(
          extensions.flatMap(({ definition, token }) =>
            HashSet.has(completeProjectExtensionIds, definition.id)
              ? (definition.projectOpeningProviders ?? []).map((contribution) =>
                  ownContribution(definition.id, token, contribution),
                )
              : [],
          ),
        ),
      ),
      titlebarActions: Object.freeze(
        orderedContributions(
          extensions.flatMap(({ definition, token }) =>
            HashSet.has(completeProjectExtensionIds, definition.id)
              ? (definition.titlebarActions ?? []).map((contribution) =>
                  ownContribution(definition.id, token, contribution),
                )
              : [],
          ),
        ),
      ),
    })
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A failed React subscription must not strand extension ownership or block other hosts.
      }
    }
  }
}

const composeRegisteredProjectContributions = (extensions: readonly RegisteredExtension[]) => {
  const projectActivities = extensions.flatMap(({ definition, token }) =>
    (definition.projectActivities ?? []).map((contribution) =>
      ownContribution(definition.id, token, contribution),
    ),
  )
  const projectSurfaces = extensions.flatMap(({ definition, token }) =>
    (definition.projectSurfaces ?? []).map((contribution) =>
      ownContribution(definition.id, token, contribution),
    ),
  )
  const projectNavigation = extensions.flatMap(({ definition, token }) =>
    (definition.projectNavigation ?? []).map((contribution) =>
      ownContribution(definition.id, token, contribution),
    ),
  )
  const projectSurfaceProviders = extensions.flatMap(({ definition, token }) =>
    (definition.projectSurfaceProviders ?? []).map((contribution) =>
      ownContribution(definition.id, token, contribution),
    ),
  )

  let availableSurfaces = HashSet.fromIterable(projectSurfaces.map(({ surface }) => surface))
  while (true) {
    const availableActivities = projectActivities
      .map((activity) => projectActivityToAvailableSurfaces(activity, availableSurfaces))
      .filter((activity) => activity.supportedSurfaces.length > 0)
    const completeSurfaces = projectSurfaces.filter((surface) => {
      if (!HashSet.has(availableSurfaces, surface.surface)) return false
      const defaultActivity = availableActivities.find(
        (activity) => activity.id === surface.defaultActivityId,
      )
      const markedDefaults = availableActivities.filter((activity) =>
        activity.defaultForSurfaces?.includes(surface.surface),
      )
      const matchingNavigation = projectNavigation.filter(
        (navigation) =>
          navigation.ownerExtensionId === surface.ownerExtensionId &&
          navigation.surface === surface.surface,
      )
      return (
        defaultActivity?.supportedSurfaces.includes(surface.surface) === true &&
        markedDefaults.length === 1 &&
        markedDefaults[0]?.id === surface.defaultActivityId &&
        matchingNavigation.length === 1
      )
    })
    const nextAvailableSurfaces = HashSet.fromIterable(
      completeSurfaces.map(({ surface }) => surface),
    )
    if (
      HashSet.size(nextAvailableSurfaces) === HashSet.size(availableSurfaces) &&
      HashSet.isSubset(nextAvailableSurfaces, availableSurfaces)
    )
      break
    availableSurfaces = nextAvailableSurfaces
  }

  const availableActivities = orderedContributions(
    projectActivities
      .map((activity) => projectActivityToAvailableSurfaces(activity, availableSurfaces))
      .filter((activity) => activity.supportedSurfaces.length > 0),
  )
  return {
    projectActivities: availableActivities,
    projectSurfaces: orderedContributions(
      projectSurfaces.filter(({ surface }) => HashSet.has(availableSurfaces, surface)),
    ),
    projectSurfaceProviders: orderedContributions(
      projectSurfaceProviders.filter(({ surface }) => HashSet.has(availableSurfaces, surface)),
    ),
    projectNavigation: orderedContributions(
      projectNavigation.filter(({ surface }) => HashSet.has(availableSurfaces, surface)),
    ),
  }
}

const projectActivityToAvailableSurfaces = (
  activity: OwnedExtensionContribution<ProjectActivityContribution>,
  availableSurfaces: HashSet.HashSet<ProjectWorkspaceSurfaceType>,
): OwnedExtensionContribution<ProjectActivityContribution> =>
  Object.freeze({
    ...activity,
    supportedSurfaces: Object.freeze(
      activity.supportedSurfaces.filter((surface) => HashSet.has(availableSurfaces, surface)),
    ),
    defaultForSurfaces: Object.freeze(
      (activity.defaultForSurfaces ?? []).filter((surface) =>
        HashSet.has(availableSurfaces, surface),
      ),
    ),
  })

/** Builds a registry from trusted definitions without partially exposing failed composition. */
export const makeTrustedExtensionRegistry = (
  extensions: readonly TrustedBuiltInExtension[],
): Result.Result<TrustedExtensionRegistry, TrustedExtensionRegistrationError> => {
  const registry = new TrustedExtensionRegistry()
  const registration = registry.registerAll(extensions)
  if (Result.isFailure(registration)) return Result.fail(registration.failure)
  return Result.succeed(registry)
}

const extensionContributions = (
  extension: TrustedBuiltInExtension,
): readonly { readonly id: string }[] => {
  const contributions: Array<{ readonly id: string }> = []
  for (const activity of extension.projectActivities ?? []) {
    contributions.push(activity)
    if (activity.slots?.contextPane !== undefined) contributions.push(activity.slots.contextPane)
    if (activity.slots?.mainPane !== undefined) contributions.push(activity.slots.mainPane)
    if (activity.slots?.detailPane !== undefined) contributions.push(activity.slots.detailPane)
  }
  for (const surface of extension.projectSurfaces ?? []) {
    contributions.push(surface.defaultMainPane)
  }
  contributions.push(
    ...(extension.globalNavigation ?? []),
    ...(extension.projectSurfaces ?? []),
    ...(extension.projectSurfaceProviders ?? []),
    ...(extension.projectNavigation ?? []),
    ...(extension.codeSourceContributions ?? []),
    ...(extension.reviewDiffContributions ?? []),
    ...(extension.projectProviders ?? []),
    ...(extension.projectOpeningProviders ?? []),
    ...(extension.titlebarActions ?? []),
  )
  return contributions
}

const ownContribution = <Contribution>(
  ownerExtensionId: TrustedExtensionId,
  ownerRegistrationToken: TrustedExtensionRegistrationToken,
  contribution: Contribution,
): OwnedExtensionContribution<Contribution> =>
  Object.freeze(Object.assign({}, contribution, { ownerExtensionId, ownerRegistrationToken }))

const freezeExtensionDefinition = (extension: TrustedBuiltInExtension): TrustedBuiltInExtension =>
  Object.freeze({
    id: extension.id,
    globalNavigation: Object.freeze(
      (extension.globalNavigation ?? []).map((contribution) =>
        Object.freeze(Object.assign({}, contribution)),
      ),
    ),
    projectActivities: Object.freeze(
      (extension.projectActivities ?? []).map((contribution) => {
        const { slots, ...activity } = contribution
        const frozenActivity = {
          ...activity,
          supportedSurfaces: Object.freeze([...contribution.supportedSurfaces]),
          defaultForSurfaces: Object.freeze([...(contribution.defaultForSurfaces ?? [])]),
        }
        if (slots === undefined) return Object.freeze(frozenActivity)

        const frozenSlots: {
          contextPane?: ProjectActivityContextPaneContribution
          mainPane?: ProjectActivityMainPaneContribution
          detailPane?: ProjectActivityDetailPaneContribution
        } = {}
        if (slots.contextPane !== undefined)
          frozenSlots.contextPane = Object.freeze({ ...slots.contextPane })
        if (slots.mainPane !== undefined)
          frozenSlots.mainPane = Object.freeze({ ...slots.mainPane })
        if (slots.detailPane !== undefined)
          frozenSlots.detailPane = Object.freeze({ ...slots.detailPane })

        return Object.freeze({ ...frozenActivity, slots: Object.freeze(frozenSlots) })
      }),
    ),
    projectSurfaces: Object.freeze(
      (extension.projectSurfaces ?? []).map((contribution) =>
        Object.freeze({
          ...contribution,
          defaultMainPane: Object.freeze({ ...contribution.defaultMainPane }),
        }),
      ),
    ),
    projectSurfaceProviders: Object.freeze(
      (extension.projectSurfaceProviders ?? []).map((contribution) =>
        Object.freeze(Object.assign({}, contribution)),
      ),
    ),
    projectNavigation: Object.freeze(
      (extension.projectNavigation ?? []).map((contribution) =>
        Object.freeze(Object.assign({}, contribution)),
      ),
    ),
    codeSourceContributions: Object.freeze(
      (extension.codeSourceContributions ?? []).map((contribution) =>
        Object.freeze(Object.assign({}, contribution)),
      ),
    ),
    reviewDiffContributions: Object.freeze(
      (extension.reviewDiffContributions ?? []).map((contribution) =>
        Object.freeze(Object.assign({}, contribution)),
      ),
    ),
    projectProviders: Object.freeze(
      (extension.projectProviders ?? []).map((contribution) =>
        Object.freeze(Object.assign({}, contribution)),
      ),
    ),
    projectOpeningProviders: Object.freeze(
      (extension.projectOpeningProviders ?? []).map((contribution) =>
        Object.freeze(Object.assign({}, contribution)),
      ),
    ),
    titlebarActions: Object.freeze(
      (extension.titlebarActions ?? []).map((contribution) =>
        Object.freeze(Object.assign({}, contribution)),
      ),
    ),
  })

const orderedContributions = <Contribution extends { readonly id: string; readonly order: number }>(
  contributions: readonly Contribution[],
): readonly Contribution[] =>
  EffectArray.sort(
    contributions,
    Order.make((left: Contribution, right: Contribution) => {
      if (left.order < right.order) return -1
      if (left.order > right.order) return 1
      if (left.id < right.id) return -1
      return 1
    }),
  )
