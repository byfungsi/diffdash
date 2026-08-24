import type { ProjectWorkspaceActivityId } from "@diffdash/domain/project-workspace"
import type {
  ProjectWorkspaceActivitySurfacePolicy,
  ProjectWorkspaceSurface,
} from "@diffdash/domain/project-workspace"
import type { ParsedDiffFile } from "@diffdash/domain/diff"
import type { ReviewProjectId } from "@diffdash/domain/review-identity"
import type { ReviewRevision } from "@diffdash/domain/review-identity"
import type { GitCommitSha } from "@diffdash/domain/repository-comparison"
import type { RepositoryCheckoutPath } from "@diffdash/domain/repository"
import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import type {
  ReviewThreadAnchor,
  ReviewThreadDetails,
  ReviewThreadId,
  ReviewThreadTarget,
} from "@diffdash/domain/review-thread"
import { Array as EffectArray, Option, Order, Result, Schema } from "effect"
import type { ComponentType, ReactNode } from "react"

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
export const TrustedExtensionContributionId = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(128)),
  Schema.check(
    Schema.makeFilter((value) => trustedExtensionIdPattern.test(value), {
      message: "Expected a namespaced trusted extension contribution ID",
    }),
  ),
  Schema.brand("TrustedExtensionContributionId"),
)

/** Stable lowercase namespace identifying one renderer contribution. */
export type TrustedExtensionContributionId = typeof TrustedExtensionContributionId.Type

/** Closed renderer-owned icon token for project activity contributions. */
export type ProjectActivityIcon = "reviews" | "files" | "code" | "walkthrough" | "comments"

/** Code-surface context supplied to a trusted project activity pane. */
export interface CodeProjectActivityPaneProps {
  readonly surface: "code"
  readonly projectId: ReviewProjectId
  readonly workspaceRevision: ReviewRevision | null
  readonly selectedPath: RepositoryRelativePath | null
  readonly selectPath: (path: RepositoryRelativePath) => void
}

/** Review-surface context supplied to a trusted project activity pane. */
export interface ReviewProjectActivityPaneProps {
  readonly surface: "review"
  readonly projectId: ReviewProjectId
  readonly target: ReviewThreadTarget
}

/** Closed semantic context supplied to a trusted project activity pane. */
export type ProjectActivityPaneProps = CodeProjectActivityPaneProps | ReviewProjectActivityPaneProps

/** Trusted project activity metadata rendered by the shared workspace host. */
export interface ProjectActivityContribution {
  readonly id: ProjectWorkspaceActivityId
  readonly label: string
  readonly icon: ProjectActivityIcon
  readonly order: number
  readonly supportedSurfaces: readonly ProjectWorkspaceSurface[]
  readonly surfacePolicy: ProjectWorkspaceActivitySurfacePolicy
  readonly paneComponent?: ComponentType<ProjectActivityPaneProps>
  readonly reviewDiffContributionId?: TrustedExtensionContributionId
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

/** Host callbacks supplied while a contribution renders its context pane. */
export interface ReviewDiffContributionContextPaneProps {
  readonly navigableThreadIds: ReadonlySet<ReviewThreadId>
  readonly settings: ReactNode
  readonly onCollapse: () => void
}

/** Host callbacks supplied while a contribution renders its detail pane. */
export interface ReviewDiffContributionDetailPaneProps {
  readonly navigableThreadIds: ReadonlySet<ReviewThreadId>
  readonly onClose: () => void
  readonly onGoToDiff: (details: ReviewThreadDetails) => void
}

/** Live semantic output registered by one mounted review diff contribution. */
export interface ReviewDiffContributionOutput {
  readonly activeLineAnchor: ReviewThreadAnchor | null
  readonly details: readonly ReviewThreadDetails[]
  readonly loading: boolean
  readonly listOpen: boolean
  readonly detailOpen: boolean
  readonly annotations: (
    file: ParsedDiffFile,
    navigationAnchor: ReviewThreadAnchor | null,
  ) => readonly ReviewDiffContributionAnnotation[]
  readonly activateLine: (
    file: ParsedDiffFile,
    side: "additions" | "deletions",
    lineNumber: number,
  ) => boolean
  readonly annotationsRendered: (card: HTMLElement) => void
  readonly openDetail: (details: ReviewThreadDetails) => void
  readonly revealLine: (anchor: ReviewThreadAnchor) => void
  readonly showList: () => void
  readonly collapse: () => void
  readonly renderContextPane: (props: ReviewDiffContributionContextPaneProps) => ReactNode
  readonly renderDetailPane: (props: ReviewDiffContributionDetailPaneProps) => ReactNode
}

/** One trusted component mounted for the active review diff host. */
export interface ReviewDiffContribution {
  readonly id: TrustedExtensionContributionId
  readonly order: number
  readonly component: ComponentType<ReviewDiffContributionProps>
}

/** Project scope supplied to one trusted extension state provider. */
export interface TrustedProjectProviderProps {
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
  readonly projectActivities?: readonly ProjectActivityContribution[]
  readonly codeSourceContributions?: readonly CodeSourceContribution[]
  readonly reviewDiffContributions?: readonly ReviewDiffContribution[]
  readonly projectProviders?: readonly TrustedProjectProviderContribution[]
  readonly titlebarActions?: readonly TrustedTitlebarActionContribution[]
}

/** Registered contribution annotated with the extension that owns its lifecycle. */
export type OwnedExtensionContribution<Contribution> = Contribution & {
  readonly ownerExtensionId: TrustedExtensionId
}

/** Immutable registry view consumed by project and source-surface hosts. */
export interface TrustedExtensionRegistrySnapshot {
  readonly projectActivities: readonly OwnedExtensionContribution<ProjectActivityContribution>[]
  readonly codeSourceContributions: readonly OwnedExtensionContribution<CodeSourceContribution>[]
  readonly reviewDiffContributions: readonly OwnedExtensionContribution<ReviewDiffContribution>[]
  readonly projectProviders: readonly OwnedExtensionContribution<TrustedProjectProviderContribution>[]
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

/** Expected failure from trusted renderer extension registration. */
export type TrustedExtensionRegistrationError =
  | DuplicateTrustedExtensionError
  | DuplicateTrustedContributionError

interface RegisteredExtension {
  readonly definition: TrustedBuiltInExtension
  readonly token: object
}

const EMPTY_REGISTRY_SNAPSHOT: TrustedExtensionRegistrySnapshot = Object.freeze({
  projectActivities: Object.freeze([]),
  codeSourceContributions: Object.freeze([]),
  reviewDiffContributions: Object.freeze([]),
  projectProviders: Object.freeze([]),
  titlebarActions: Object.freeze([]),
})

/** Synchronous registry for statically trusted renderer extensions bundled with DiffDash. */
export class TrustedExtensionRegistry {
  private readonly extensions = new Map<TrustedExtensionId, RegisteredExtension>()
  private readonly listeners = new Set<() => void>()
  private currentSnapshot: TrustedExtensionRegistrySnapshot = EMPTY_REGISTRY_SNAPSHOT

  /** Returns the stable immutable snapshot for the current registration generation. */
  readonly snapshot = (): TrustedExtensionRegistrySnapshot => this.currentSnapshot

  /** Subscribes a host to registry generation changes. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Atomically registers one extension and returns an ownership-safe idempotent disposer. */
  register(
    extension: TrustedBuiltInExtension,
  ): Result.Result<() => void, TrustedExtensionRegistrationError> {
    if (this.extensions.has(extension.id)) {
      return Result.fail(
        DuplicateTrustedExtensionError.make({
          extensionId: extension.id,
          message: `Trusted extension already registered: ${extension.id}`,
        }),
      )
    }

    const contributionFailure = this.findContributionIdConflict(extension)
    if (contributionFailure !== null) return Result.fail(contributionFailure)

    const definition = freezeExtensionDefinition(extension)
    const registration = { definition, token: {} }
    this.extensions.set(definition.id, registration)
    this.refreshSnapshot()

    return Result.succeed(() => {
      if (this.extensions.get(definition.id)?.token !== registration.token) return
      this.extensions.delete(definition.id)
      this.refreshSnapshot()
    })
  }

  private findContributionIdConflict(
    extension: TrustedBuiltInExtension,
  ): DuplicateTrustedContributionError | null {
    const registeredIds = this.registeredContributionIds()
    const extensionIds = new Set<string>()
    for (const contribution of extensionContributions(extension)) {
      if (registeredIds.has(contribution.id) || extensionIds.has(contribution.id)) {
        return DuplicateTrustedContributionError.make({
          extensionId: extension.id,
          contributionId: contribution.id,
          message: `Trusted extension contribution already registered: ${contribution.id}`,
        })
      }
      extensionIds.add(contribution.id)
    }
    return null
  }

  private registeredContributionIds(): Set<string> {
    const ids = new Set<string>()
    for (const registration of this.extensions.values()) {
      for (const contribution of extensionContributions(registration.definition)) {
        ids.add(contribution.id)
      }
    }
    return ids
  }

  private refreshSnapshot(): void {
    const extensions = [...this.extensions.values()].map(({ definition }) => definition)
    this.currentSnapshot = Object.freeze({
      projectActivities: Object.freeze(
        orderedContributions(
          extensions.flatMap((extension) =>
            (extension.projectActivities ?? []).map((contribution) =>
              ownContribution(extension.id, contribution),
            ),
          ),
        ),
      ),
      codeSourceContributions: Object.freeze(
        orderedContributions(
          extensions.flatMap((extension) =>
            (extension.codeSourceContributions ?? []).map((contribution) =>
              ownContribution(extension.id, contribution),
            ),
          ),
        ),
      ),
      reviewDiffContributions: Object.freeze(
        orderedContributions(
          extensions.flatMap((extension) =>
            (extension.reviewDiffContributions ?? []).map((contribution) =>
              ownContribution(extension.id, contribution),
            ),
          ),
        ),
      ),
      projectProviders: Object.freeze(
        orderedContributions(
          extensions.flatMap((extension) =>
            (extension.projectProviders ?? []).map((contribution) =>
              ownContribution(extension.id, contribution),
            ),
          ),
        ),
      ),
      titlebarActions: Object.freeze(
        orderedContributions(
          extensions.flatMap((extension) =>
            (extension.titlebarActions ?? []).map((contribution) =>
              ownContribution(extension.id, contribution),
            ),
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

/** Builds a registry from trusted definitions without partially exposing failed composition. */
export const makeTrustedExtensionRegistry = (
  extensions: readonly TrustedBuiltInExtension[],
): Result.Result<TrustedExtensionRegistry, TrustedExtensionRegistrationError> => {
  const registry = new TrustedExtensionRegistry()
  for (const extension of extensions) {
    const registration = registry.register(extension)
    if (Result.isFailure(registration)) return Result.fail(registration.failure)
  }
  return Result.succeed(registry)
}

const extensionContributions = (extension: TrustedBuiltInExtension) => [
  ...(extension.projectActivities ?? []),
  ...(extension.codeSourceContributions ?? []),
  ...(extension.reviewDiffContributions ?? []),
  ...(extension.projectProviders ?? []),
  ...(extension.titlebarActions ?? []),
]

const ownContribution = <Contribution>(
  ownerExtensionId: TrustedExtensionId,
  contribution: Contribution,
): OwnedExtensionContribution<Contribution> =>
  Object.freeze(Object.assign({}, contribution, { ownerExtensionId }))

const freezeExtensionDefinition = (extension: TrustedBuiltInExtension): TrustedBuiltInExtension =>
  Object.freeze({
    id: extension.id,
    projectActivities: Object.freeze(
      (extension.projectActivities ?? []).map((contribution) =>
        Object.freeze(
          Object.assign({}, contribution, {
            supportedSurfaces: Object.freeze([...contribution.supportedSurfaces]),
          }),
        ),
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
      return left.id < right.id ? -1 : 1
    }),
  )
