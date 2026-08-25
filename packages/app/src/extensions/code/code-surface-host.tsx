import { Option } from "effect"

import { CodeScreen, type CodeScreenProps } from "./code-screen"
import { useCodeNavigationController } from "./code-navigation"
import { useTrustedExtensionRegistry } from "../extension-registry-context"
import { useProjectSurfaceRuntime } from "../project-surface-runtime"
import { useCodeSurfaceEnvironment } from "./code-surface-capability"

/** Registered Code surface entrypoint resolved from the trusted extension registry. */
export const CodeExtensionSurface = () => {
  const host = useProjectSurfaceRuntime()
  const environment = useCodeSurfaceEnvironment(host.colorScheme)
  const navigation = useCodeNavigationController()
  const { codeSourceContributions, projectNavigation, projectSurfaces } =
    useTrustedExtensionRegistry()
  const contribution = projectNavigation.find(({ surface }) => surface === "code")
  const surfaceContribution = projectSurfaces.find(({ surface }) => surface === "code")
  const activeActivity = host.activities.find(({ id }) => id === host.activeActivity)
  if (
    contribution === undefined ||
    surfaceContribution === undefined ||
    activeActivity === undefined
  )
    return null
  const props: CodeScreenProps = {
    active: host.activeSurface === "code",
    activeActivity: host.activeActivity,
    activities: host.activities,
    codeThemes: environment.codeThemes,
    codeSourceContributions,
    colorScheme: environment.colorScheme,
    contextWidth: environment.contextWidth,
    fileStatuses: navigation.fileStatuses,
    historyDefinitionNavigation: navigation.definitionNavigation,
    lineChanges: navigation.lineChanges,
    repo: host.repo,
    surfaceContribution,
    selectedPath: Option.getOrNull(navigation.path),
    sidebarExpanded: host.sidebarExpanded,
    target: Option.getOrElse(navigation.target, () => {
      throw new Error("Code navigation was not restored before mounting its surface")
    }),
    threadDetailWidth: environment.threadDetailWidth,
    onActiveActivityChange: host.selectActivity,
    onHistoryDefinitionNavigationHandled: navigation.handleDefinitionNavigation,
    onLinkRepository: environment.linkRepository,
    onNavigateToDefinition: (destination) => {
      const currentState = navigation.encodeCodeLocation({
        target: Option.getOrThrow(navigation.target),
        path: navigation.path,
        revealRange: Option.none(),
        fileStatuses: navigation.fileStatuses,
        lineChanges: navigation.lineChanges,
      })
      const destinationState = navigation.navigateCodeDefinition(currentState, destination)
      if (
        !host.navigate(
          contribution,
          host.activeActivity,
          navigation.revealCodeOrigin(currentState, destination.origin.range),
          "replace",
        )
      )
        return
      if (host.navigate(contribution, host.activeActivity, destinationState)) {
        void host.persistLocation(contribution, activeActivity, destinationState)
      }
    },
    onSelectedPathChange: (path) => {
      const currentState = navigation.encodeCodeLocation({
        target: Option.getOrThrow(navigation.target),
        path: navigation.path,
        revealRange: Option.none(),
        fileStatuses: navigation.fileStatuses,
        lineChanges: navigation.lineChanges,
      })
      const selectedState = navigation.selectCodePath(currentState, Option.fromNullishOr(path))
      if (host.navigate(contribution, host.activeActivity, selectedState)) {
        void host.persistLocation(contribution, activeActivity, selectedState)
      }
    },
    onSidebarExpandedChange: host.setSidebarExpanded,
    onSidebarWidthChange: environment.updateContextWidth,
    onThreadDetailWidthChange: environment.updateThreadDetailWidth,
  }
  return <CodeScreen {...props} />
}
