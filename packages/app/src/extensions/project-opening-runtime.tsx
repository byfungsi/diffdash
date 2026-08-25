import type { ProjectRemoteSelectionRequired } from "@diffdash/domain/project-workspace"
import type { HostedRepositoryLocator } from "@diffdash/domain/git-provider"
import type { Repo } from "@diffdash/domain/repository"
import type { CliNavigationCommand } from "@diffdash/protocol/cli-navigation"
import { Data, HashMap, HashSet, type Option } from "effect"
import { createContext, type ReactNode, use, useLayoutEffect, useRef, useState } from "react"

import type {
  OwnedExtensionContribution,
  ProjectNavigationResult,
  ProjectOpeningProviderContribution,
  TrustedExtensionRegistrationToken,
} from "./extension-registry"
import { useTrustedExtensionRegistry } from "./extension-registry-context"
import type { CommandPaletteItem } from "@/shell/command-palette"

/** Opaque continuation for a project open requiring repository disambiguation. */
export interface PendingProjectRemoteSelection {
  readonly selection: ProjectRemoteSelectionRequired
  readonly resume: (repository: HostedRepositoryLocator) => Promise<ProjectOpeningResult>
}

/** Extension-neutral result of asking the active project owner to open a destination. */
export type ProjectOpeningResult = Data.TaggedEnum<{
  opened: {
    readonly projection: ProjectNavigationResult
    readonly persistence: () => Promise<void>
  }
  remoteSelectionRequired: { readonly pending: PendingProjectRemoteSelection }
  unavailable: {}
}>

/** Constructors and exhaustive matching for extension-neutral project-opening results. */
export const ProjectOpeningResult = Data.taggedEnum<ProjectOpeningResult>()

/** Extension-neutral result of restoring one persisted project destination. */
export type ProjectRestoreResult = Data.TaggedEnum<{
  restored: {
    readonly projection: ProjectNavigationResult
    readonly persistence: Option.Option<() => Promise<void>>
  }
  stale: {}
  unavailable: {}
}>

/** Constructors and exhaustive matching for extension-neutral project-restoration results. */
export const ProjectRestoreResult = Data.taggedEnum<ProjectRestoreResult>()

/** Result of offering one host CLI command to the active project-opening owner. */
export type ProjectOpeningCommandClaim = Data.TaggedEnum<{
  handled: {
    readonly request: Promise<ProjectOpeningResult>
    readonly failureMessage: string
  }
  unhandled: {}
}>

/** Constructors and exhaustive matching for owner command claims. */
export const ProjectOpeningCommandClaim = Data.taggedEnum<ProjectOpeningCommandClaim>()

/** Generic props used by an owner to contribute command-palette destinations. */
export interface ProjectOpeningCommandPaletteProps {
  readonly repo: Repo | null
  readonly apply: (projection: ProjectNavigationResult) => void
  readonly render: (items: readonly CommandPaletteItem[]) => ReactNode
}

/** Project-opening operations supplied by the active registered owner. */
export interface ProjectOpeningRuntime {
  readonly cancelRestore: () => void
  readonly initial: (repo: Repo) => Option.Option<ProjectNavigationResult>
  readonly defaultProject: (
    repo: Repo,
    notice: Option.Option<string>,
  ) => Option.Option<ProjectNavigationResult>
  readonly restore: (repo: Repo) => Promise<ProjectRestoreResult>
  readonly persist: (projection: ProjectNavigationResult) => Promise<boolean>
  readonly persistLocation: (location: ProjectNavigationResult) => Promise<boolean>
  readonly openProject: (localPath: string) => Promise<ProjectOpeningResult>
  readonly claimCommand: (command: CliNavigationCommand) => ProjectOpeningCommandClaim
  readonly CommandPaletteItems: (props: ProjectOpeningCommandPaletteProps) => ReactNode
}

const ProjectOpeningRuntimeContext = createContext<ProjectOpeningRuntime | null>(null)
const EMPTY_PROJECT_OPENING_PROVIDERS: readonly OwnedExtensionContribution<ProjectOpeningProviderContribution>[] =
  []
interface ProjectOpeningRuntimeRegistration {
  readonly runtime: ProjectOpeningRuntime
  readonly token: TrustedExtensionRegistrationToken
}
interface ProjectOpeningRuntimeRegistrar {
  readonly register: (registration: ProjectOpeningRuntimeRegistration) => () => void
}
const ProjectOpeningRuntimeRegistrarContext = createContext<ProjectOpeningRuntimeRegistrar | null>(
  null,
)

/** Returns the active project-opening capability, or null when no owner is registered. */
export const useProjectOpeningRuntime = (): ProjectOpeningRuntime | null =>
  use(ProjectOpeningRuntimeContext)

/** Registers one owner runtime for exactly the lifetime of its active registration generation. */
export const useProjectOpeningRuntimeRegistration = (
  runtime: ProjectOpeningRuntime,
  registrationToken: TrustedExtensionRegistrationToken,
): void => {
  const registrar = use(ProjectOpeningRuntimeRegistrarContext)
  if (registrar === null) throw new Error("RegisteredProjectOpeningProviders is unavailable")
  const runtimeRef = useRef(runtime)
  runtimeRef.current = runtime
  useLayoutEffect(
    () => registrar.register({ runtime: runtimeRef.current, token: registrationToken }),
    [registrar, registrationToken],
  )
}

/** Keeps known provider slots stable while mounting owner state only for active generations. */
export const RegisteredProjectOpeningProviders = ({
  children,
  knownProviders = EMPTY_PROJECT_OPENING_PROVIDERS,
}: {
  readonly children: ReactNode
  readonly knownProviders?: readonly OwnedExtensionContribution<ProjectOpeningProviderContribution>[]
}) => {
  const { projectOpeningProviders } = useTrustedExtensionRegistry()
  const [registrations, setRegistrations] = useState<readonly ProjectOpeningRuntimeRegistration[]>(
    [],
  )
  const registrarRef = useRef<ProjectOpeningRuntimeRegistrar>(null)
  registrarRef.current ??= {
    register: (nextRegistration) => {
      setRegistrations((current) => [...current, nextRegistration])
      return () => {
        setRegistrations((current) =>
          current.filter((registration) => registration !== nextRegistration),
        )
      }
    },
  }
  const knownProvidersRef = useRef(
    HashMap.fromIterable(
      [...knownProviders, ...projectOpeningProviders].map((contribution) => [
        contribution.id,
        contribution,
      ]),
    ),
  )
  for (const contribution of projectOpeningProviders) {
    knownProvidersRef.current = HashMap.set(
      knownProvidersRef.current,
      contribution.id,
      contribution,
    )
  }
  const orderedActiveContributions = [...projectOpeningProviders].sort(
    compareProjectOpeningProviders,
  )
  const activeContributionIds = HashSet.fromIterable(orderedActiveContributions.map(({ id }) => id))
  const activeRegistration = orderedActiveContributions
    .map((contribution) =>
      registrations.find(
        (registration) => registration.token === contribution.ownerRegistrationToken,
      ),
    )
    .find((registration) => registration !== undefined)
  const providerSlots = Array.from(knownProvidersRef.current, ([, knownContribution]) => {
    return (
      projectOpeningProviders.find(({ id }) => id === knownContribution.id) ?? knownContribution
    )
  })
    .sort(compareProjectOpeningProviders)
    .map((contribution) => {
      const Provider = contribution.component
      return (
        <Provider
          key={`${contribution.ownerExtensionId}:${contribution.id}:${contribution.ownerRegistrationToken.reactKey}`}
          active={HashSet.has(activeContributionIds, contribution.id)}
          registrationToken={contribution.ownerRegistrationToken}
        >
          {null}
        </Provider>
      )
    })
  return (
    <ProjectOpeningRuntimeRegistrarContext value={registrarRef.current}>
      <ProjectOpeningRuntimeContext value={activeRegistration?.runtime ?? null}>
        {providerSlots}
        {children}
      </ProjectOpeningRuntimeContext>
    </ProjectOpeningRuntimeRegistrarContext>
  )
}

const compareProjectOpeningProviders = (
  left: OwnedExtensionContribution<ProjectOpeningProviderContribution>,
  right: OwnedExtensionContribution<ProjectOpeningProviderContribution>,
): number => left.order - right.order || left.id.localeCompare(right.id)
