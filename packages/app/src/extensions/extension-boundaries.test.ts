import { describe, expect, it } from "vitest"

const sourceModules = import.meta.glob<string>(
  [
    "../shell/app-navigation-history.ts",
    "../shell/app-shell.tsx",
    "../home/home-global-destination.tsx",
    "./extension-registry.ts",
    "./project-opening-runtime.tsx",
    "./project-surface-runtime.tsx",
    "../project-workspace/project-workspace-frame.tsx",
    "../review/review-detail-view.tsx",
    "./review/review-screen.tsx",
    "../../../domain/src/project-workspace.ts",
  ],
  { query: "?raw", import: "default", eager: true },
)

const extensionBoundarySource = (path: string): string => {
  const source = sourceModules[path]
  if (source === undefined) throw new Error(`Extension boundary source is unavailable: ${path}`)
  return source
}

const appNavigationHistorySource = extensionBoundarySource("../shell/app-navigation-history.ts")
const appShellSource = extensionBoundarySource("../shell/app-shell.tsx")
const homeGlobalDestinationSource = extensionBoundarySource("../home/home-global-destination.tsx")
const extensionRegistrySource = extensionBoundarySource("./extension-registry.ts")
const projectOpeningRuntimeSource = extensionBoundarySource("./project-opening-runtime.tsx")
const projectSurfaceRuntimeSource = extensionBoundarySource("./project-surface-runtime.tsx")
const projectWorkspaceFrameSource = extensionBoundarySource(
  "../project-workspace/project-workspace-frame.tsx",
)
const reviewDetailViewSource = extensionBoundarySource("../review/review-detail-view.tsx")
const reviewScreenSource = extensionBoundarySource("./review/review-screen.tsx")
const projectWorkspaceDomainSource = extensionBoundarySource(
  "../../../domain/src/project-workspace.ts",
)

describe("trusted extension source boundaries", () => {
  it("keeps built-in activity identities out of generic hosts", () => {
    const genericHostSource = [
      appShellSource,
      projectWorkspaceFrameSource,
      reviewDetailViewSource,
    ].join("\n")

    expect(genericHostSource).not.toMatch(
      /PROJECT_WORKSPACE_(?:REVIEWS|FILES|CODE|WALKTHROUGH)_ACTIVITY_ID|REVIEW_COMMENTS_ACTIVITY_ID/u,
    )
  })

  it("keeps concrete activity identities out of generic domain", () => {
    expect(projectWorkspaceDomainSource).not.toMatch(
      /PROJECT_WORKSPACE_(?:REVIEWS|FILES|CODE|WALKTHROUGH)_ACTIVITY_ID|REVIEW_COMMENTS_ACTIVITY_ID|diffdash\.core\.(?:reviews|files|code|walkthrough)|diffdash\.builtin\.review-comments\.comments/u,
    )
  })

  it("keeps extension-owned location shapes out of global history", () => {
    const globalNavigationSource = [appShellSource, appNavigationHistorySource].join("\n")

    expect(globalNavigationSource).not.toMatch(
      /projectCode|projectReview|location\.(?:target|path|revealRange|fileStatuses|lineChanges)/u,
    )
    expect(appShellSource).not.toMatch(
      /CODE_NAVIGATION_ID|REVIEW_NAVIGATION_ID|restoreCodeNavigationState|restoreReviewNavigationState|CodeSurfaceHostProvider|ReviewSurfaceHostProvider|useCodeNavigationController|useReviewNavigationController/u,
    )
    expect(appShellSource).not.toMatch(
      /\b(?:target|path|revealRange|fileStatuses|lineChanges|selectedReview):/u,
    )
    expect(globalNavigationSource).not.toMatch(/kind:\s*["']home["']/u)
  })

  it("keeps Home construction and feature policy behind its global contribution", () => {
    expect(appShellSource).not.toMatch(
      /HomeScreen|home-screen|hostedRepositoryLabel|repositorySearchAtom|remoteRepositorySearchAtom|searchScopesAtom|providersAtom/iu,
    )
    expect(appShellSource).not.toMatch(
      /renderActiveGlobalDestination\s*\(\s*content|\.render\([^)]*content/iu,
    )
    expect(extensionRegistrySource).toMatch(
      /interface GlobalNavigationContribution[\s\S]*?readonly component: ComponentType<GlobalNavigationDestinationProps>/u,
    )
    expect(extensionRegistrySource).not.toMatch(
      /interface GlobalNavigationContribution[\s\S]*?readonly render:[^\n]*content/u,
    )
    expect(homeGlobalDestinationSource).toMatch(/HomeScreen|repositorySearchAtom|diagnosticsAtom/u)
  })

  it("keeps Review projection policy out of the generic shell and registry", () => {
    expect(appShellSource).not.toMatch(
      /selectedReviewTarget|defaultWhenReviewSelected|reviewQuickNavigationRequest|ProjectOpenIntent|kind:\s*["'](?:hosted|localDiff|repositoryComparison)["']/u,
    )
    expect(appShellSource).not.toMatch(
      /ProjectSession|openWorkingTree|openBranchDiff|openLastCommit|openRepositoryComparison|openPullRequest/u,
    )
    const genericProjectContracts = [
      extensionRegistrySource,
      projectOpeningRuntimeSource,
      projectSurfaceRuntimeSource,
    ].join("\n")
    expect(genericProjectContracts).not.toMatch(
      /ProjectSessionProjection|ProjectWorkspaceStateInput|selectedReviewOption|selectedReviewTarget|createProjectState|restoreWorkspaceState/u,
    )
    expect(appShellSource).not.toMatch(
      /defaultActivityForSurface\(["']review["']\)|initialProjectSurface|review\.toggleSidebar|reviewSidebarExpanded/u,
    )
    expect(sourceModules).not.toHaveProperty("../shell/project-session.ts")
  })

  it("keeps owner-specific project-opening inputs in their extension", () => {
    expect(projectOpeningRuntimeSource).not.toMatch(
      /AnalyticsEvent|HostedReviewSummary|openWorkingTree|openBranchDiff|openLastCommit|openRepositoryComparison|openPullRequest/u,
    )
    expect(appShellSource).not.toMatch(/HostedReviewSummary|useReviewProjectOpeningRuntime/u)
  })

  it("keeps activity visuals and surface semantics owner-defined", () => {
    expect(extensionRegistrySource).not.toMatch(
      /ProjectActivityIcon(?!Props)|ReviewActivityPresentation|reviewPresentation|icon:\s*["'](?:reviews|files|code|walkthrough|comments)["']/u,
    )
    expect(extensionRegistrySource).toMatch(
      /interface ProjectSurfaceLocation \{\s*readonly projectId: ReviewProjectId\s*readonly surface: ProjectWorkspaceSurfaceType\s*\}/u,
    )
    expect(extensionRegistrySource).toMatch(
      /interface ProjectActivityPaneProps \{\s*readonly location: ProjectSurfaceLocation\s*readonly paneHost: ProjectActivityPaneHostControls\s*\}/u,
    )
    expect(extensionRegistrySource).not.toMatch(
      /CodeProjectActivityPaneProps|ReviewProjectActivityPaneProps/u,
    )
  })

  it("keeps owner resources out of generic project surface mechanics", () => {
    expect(projectSurfaceRuntimeSource).not.toMatch(
      /AISettings|HostedRepositoryLocator|linkRepository|threadDetailWidth|ReviewPaneSettings|ReviewThreadTarget|RepositoryRelativePath/u,
    )
  })

  it("keeps Review hosts free of optional owner presentation vocabulary", () => {
    expect([reviewScreenSource, reviewDetailViewSource].join("\n")).not.toMatch(
      /reviewPresentation|ReviewActivityPresentation|ReviewWorkspaceRibbon|projectRibbonToSidebarTab|activityPresentation/u,
    )
  })
})
