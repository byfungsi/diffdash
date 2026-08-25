import { HashMap, HashSet, Option } from "effect"
import { createContext, type ReactNode, use, useLayoutEffect, useRef } from "react"

import type {
  EncodedExtensionLocation,
  OwnedExtensionContribution,
  ProjectNavigationContribution,
  ProjectNavigationEntry,
  TrustedExtensionContributionId,
  TrustedExtensionRegistrationToken,
} from "./extension-registry"
import {
  useTrustedExtensionRegistry,
  useTrustedExtensionRegistryController,
} from "./extension-registry-context"

type ProjectNavigationRestoreHandler = (state: EncodedExtensionLocation) => void
interface RegisteredProjectNavigationRestoreHandler {
  readonly registrationToken: TrustedExtensionRegistrationToken
  readonly dispose: () => void
  readonly restore: ProjectNavigationRestoreHandler
}

interface ProjectNavigationRuntime {
  readonly register: (
    contributionId: TrustedExtensionContributionId,
    registrationToken: TrustedExtensionRegistrationToken,
    handler: ProjectNavigationRestoreHandler,
    dispose: () => void,
  ) => () => void
  readonly subscribeRestoration: (listener: (entry: ProjectNavigationEntry) => void) => () => void
  readonly restore: (entry: ProjectNavigationEntry) => boolean
}

const ProjectNavigationRuntimeContext = createContext<ProjectNavigationRuntime | null>(null)

/** Owns runtime restoration handlers registered by active navigation contributions. */
export const ProjectNavigationRuntimeProvider = ({
  children,
}: {
  readonly children: ReactNode
}) => {
  const registry = useTrustedExtensionRegistryController()
  const handlersRef = useRef(
    HashMap.empty<TrustedExtensionContributionId, RegisteredProjectNavigationRestoreHandler>(),
  )
  const restorationListenersRef = useRef(new Set<(entry: ProjectNavigationEntry) => void>())
  const runtimeRef = useRef<ProjectNavigationRuntime>(null)
  runtimeRef.current ??= {
    register: (contributionId, registrationToken, handler, dispose) => {
      const registration = { registrationToken, restore: handler, dispose }
      handlersRef.current = HashMap.set(handlersRef.current, contributionId, registration)
      return () => {
        if (Option.contains(HashMap.get(handlersRef.current, contributionId), registration)) {
          handlersRef.current = HashMap.remove(handlersRef.current, contributionId)
        }
      }
    },
    subscribeRestoration: (listener) => {
      restorationListenersRef.current.add(listener)
      return () => restorationListenersRef.current.delete(listener)
    },
    restore: (entry) => {
      const snapshot = registry.snapshot()
      const contribution = snapshot.projectNavigation.find(({ id }) => id === entry.contributionId)
      const activity = snapshot.projectActivities.find(({ id }) => id === entry.activityId)
      if (
        contribution?.ownerRegistrationToken !== entry.registrationToken ||
        contribution.surface !== entry.surface ||
        activity?.ownerRegistrationToken !== entry.activityRegistrationToken ||
        !activity.supportedSurfaces.includes(entry.surface)
      )
        return false
      return Option.match(HashMap.get(handlersRef.current, entry.contributionId), {
        onNone: () => false,
        onSome: (handler) => {
          if (handler.registrationToken !== entry.registrationToken) return false
          restorationListenersRef.current.forEach((listener) => listener(entry))
          handler.restore(entry.state)
          return true
        },
      })
    },
  }
  useLayoutEffect(
    () =>
      registry.subscribe(() => {
        const activeContributions = HashMap.fromIterable(
          registry
            .snapshot()
            .projectNavigation.map((contribution) => [
              contribution.id,
              contribution.ownerRegistrationToken,
            ]),
        )
        for (const [contributionId, handler] of handlersRef.current) {
          if (
            Option.contains(
              HashMap.get(activeContributions, contributionId),
              handler.registrationToken,
            )
          )
            continue
          handlersRef.current = HashMap.remove(handlersRef.current, contributionId)
          handler.dispose()
        }
      }),
    [registry],
  )
  return (
    <ProjectNavigationRuntimeContext value={runtimeRef.current}>
      {children}
    </ProjectNavigationRuntimeContext>
  )
}

/** Observes every valid project restoration without decoding its owner payload. */
export const useProjectNavigationRestorationListener = (
  active: boolean,
  listener: (entry: ProjectNavigationEntry) => void,
): void => {
  const runtime = useProjectNavigationRuntime()
  const listenerRef = useRef(listener)
  listenerRef.current = listener
  useLayoutEffect(() => {
    if (!active) return undefined
    return runtime.subscribeRestoration((entry) => listenerRef.current(entry))
  }, [active, runtime])
}

/** Returns the generic runtime used to restore an opaque project navigation entry. */
export const useProjectNavigationRuntime = (): ProjectNavigationRuntime => {
  const runtime = use(ProjectNavigationRuntimeContext)
  if (runtime === null) throw new Error("ProjectNavigationRuntimeProvider is unavailable")
  return runtime
}

/** Registers one owner restore handler while its navigation contribution is active. */
export const useProjectNavigationRestoreHandler = (
  active: boolean,
  contributionId: TrustedExtensionContributionId,
  registrationToken: TrustedExtensionRegistrationToken,
  handler: ProjectNavigationRestoreHandler,
  dispose: () => void,
): void => {
  const runtime = useProjectNavigationRuntime()
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const disposeRef = useRef(dispose)
  disposeRef.current = dispose
  useLayoutEffect(() => {
    if (!active) return undefined
    return runtime.register(
      contributionId,
      registrationToken,
      (state) => handlerRef.current(state),
      () => disposeRef.current(),
    )
  }, [active, contributionId, registrationToken, runtime])
}

/** Keeps navigation provider slots stable so owner removal does not remount the shell. */
export const RegisteredProjectNavigationProviders = ({
  children,
  knownProviders = [],
}: {
  readonly children: ReactNode
  readonly knownProviders?: readonly OwnedExtensionContribution<ProjectNavigationContribution>[]
}) => {
  const { projectNavigation } = useTrustedExtensionRegistry()
  const knownProvidersRef = useRef(
    HashMap.fromIterable(
      [...knownProviders, ...projectNavigation].map((contribution) => [
        contribution.id,
        contribution,
      ]),
    ),
  )
  for (const contribution of projectNavigation) {
    knownProvidersRef.current = HashMap.set(
      knownProvidersRef.current,
      contribution.id,
      contribution,
    )
  }
  const activeContributionIds = HashSet.fromIterable(projectNavigation.map(({ id }) => id))
  return Array.from(knownProvidersRef.current, ([, knownContribution]) => {
    return (
      projectNavigation.find((contribution) => contribution.id === knownContribution.id) ??
      knownContribution
    )
  })
    .sort(compareProjectNavigationProviders)
    .reduceRight<ReactNode>((content, contribution) => {
      const Provider = contribution.component
      return (
        <Provider
          key={`${contribution.ownerExtensionId}:${contribution.id}:${contribution.ownerRegistrationToken.reactKey}`}
          active={HashSet.has(activeContributionIds, contribution.id)}
          registrationToken={contribution.ownerRegistrationToken}
        >
          {content}
        </Provider>
      )
    }, children)
}

const compareProjectNavigationProviders = (
  left: OwnedExtensionContribution<ProjectNavigationContribution>,
  right: OwnedExtensionContribution<ProjectNavigationContribution>,
): number => left.order - right.order || left.id.localeCompare(right.id)
