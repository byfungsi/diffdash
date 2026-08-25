import { type ReactNode, StrictMode, useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { Option, Result } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ProjectWorkspaceState } from "@diffdash/domain/project-workspace"
import { ReviewProjectId } from "@diffdash/domain/review-identity"

import {
  TrustedExtensionRegistryProvider,
  useTrustedExtensionRegistry,
} from "./extension-registry-context"
import { trustedBuiltInExtensions } from "./trusted-built-in-extensions"
import { makeTrustedExtensionRegistry } from "./extension-registry"
import {
  CODE_EXTENSION_ID,
  codeExtension,
  PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
} from "./code/code-extension"
import {
  PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
  REVIEW_EXTENSION_ID,
  reviewExtension,
} from "./review/review-extension"
import { ProjectSession } from "./review/review-project-session"
import { WALKTHROUGH_EXTENSION_ID, walkthroughExtension } from "./walkthrough/walkthrough-extension"
import {
  REVIEW_COMMENTS_EXTENSION_ID,
  reviewCommentsExtension,
} from "./review-comments/review-comments-extension"
import {
  codeNavigationContribution,
  createDefaultCodeNavigationState,
  useCodeNavigationController,
} from "./code/code-navigation"
import {
  encodeReviewNavigationState,
  reviewNavigationContribution,
} from "./review/review-navigation"
import { PersistentReviewSurfaceProviders } from "./review/review-surface-host"
import { TrustedProjectProviders } from "./trusted-project-providers"
import { RegisteredProjectSurface } from "./project-surface-host"
import {
  type TrustedExtensionRegistrationToken,
  type TrustedBuiltInExtension,
  TrustedExtensionContributionId,
  TrustedExtensionId,
} from "./extension-registry"
import { App } from "../app"
import { installDiffDashApi } from "../test/app-browser-support"

let root: Root | null = null

afterEach(() => {
  root?.unmount()
  root = null
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const ActivityList = () => {
  const registry = useTrustedExtensionRegistry()
  return (
    <output>
      {registry.projectActivities
        .map((activity) => `${activity.label}:${activity.ownerExtensionId}`)
        .join(",")}
    </output>
  )
}

const ProjectProviderHarness = ({ children }: { readonly children: ReactNode }) => {
  const registry = useTrustedExtensionRegistry()
  return (
    <TrustedProjectProviders
      directory={null}
      projectId={null}
      providers={registry.projectProviders}
    >
      {children}
    </TrustedProjectProviders>
  )
}

describe("TrustedExtensionRegistryProvider", () => {
  it("provides one synchronous built-in snapshot through Strict Mode remounts", async () => {
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      <StrictMode>
        <TrustedExtensionRegistryProvider extensions={trustedBuiltInExtensions}>
          <ActivityList />
        </TrustedExtensionRegistryProvider>
      </StrictMode>,
    )

    await vi.waitFor(() => {
      expect(container.textContent).toBe(
        "Reviews:diffdash.builtin.review,Files:diffdash.builtin.review,Code:diffdash.builtin.code,Walkthrough:diffdash.builtin.walkthrough,Comments:diffdash.builtin.review-comments",
      )
    })
  })

  it.each([
    {
      extensions: [reviewExtension, reviewCommentsExtension],
      expected:
        "Reviews:diffdash.builtin.review,Files:diffdash.builtin.review,Comments:diffdash.builtin.review-comments",
    },
    {
      extensions: [codeExtension, reviewCommentsExtension],
      expected: "Code:diffdash.builtin.code,Comments:diffdash.builtin.review-comments",
    },
    {
      extensions: [codeExtension, walkthroughExtension],
      expected: "Code:diffdash.builtin.code",
    },
    {
      extensions: [walkthroughExtension, codeExtension],
      expected: "Code:diffdash.builtin.code",
    },
    {
      extensions: [codeExtension, reviewCommentsExtension, walkthroughExtension],
      expected: "Code:diffdash.builtin.code,Comments:diffdash.builtin.review-comments",
    },
    {
      extensions: [walkthroughExtension, reviewCommentsExtension, codeExtension],
      expected: "Code:diffdash.builtin.code,Comments:diffdash.builtin.review-comments",
    },
  ])("cold-boots a partial multi-surface registry", async ({ extensions, expected }) => {
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      <TrustedExtensionRegistryProvider extensions={extensions}>
        <ActivityList />
      </TrustedExtensionRegistryProvider>,
    )

    await vi.waitFor(() => expect(container.textContent).toBe(expected))
  })

  it("removes one extension's ribbon contribution in one live registry generation", async () => {
    const registry = Result.getOrThrow(makeTrustedExtensionRegistry(trustedBuiltInExtensions))
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      <TrustedExtensionRegistryProvider extensions={[]} registry={registry}>
        <ActivityList />
      </TrustedExtensionRegistryProvider>,
    )

    await vi.waitFor(() => expect(container.textContent).toContain("Code:diffdash.builtin.code"))
    expect(registry.unregister(CODE_EXTENSION_ID)).toBe(true)
    await vi.waitFor(() => {
      expect(container.textContent).not.toContain("Code:diffdash.builtin.code")
      expect(container.textContent).toContain("Files:diffdash.builtin.review")
      expect(container.textContent).toContain("Walkthrough:diffdash.builtin.walkthrough")
    })
  })

  it("removes Walkthrough ownership while leaving Review activities usable", async () => {
    const registry = Result.getOrThrow(makeTrustedExtensionRegistry(trustedBuiltInExtensions))
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      <TrustedExtensionRegistryProvider extensions={[]} registry={registry}>
        <ActivityList />
      </TrustedExtensionRegistryProvider>,
    )

    await vi.waitFor(() => expect(container.textContent).toContain("Walkthrough"))
    expect(registry.unregister(WALKTHROUGH_EXTENSION_ID)).toBe(true)
    await vi.waitFor(() => {
      expect(container.textContent).not.toContain("Walkthrough")
      expect(container.textContent).toContain("Reviews:diffdash.builtin.review")
      expect(container.textContent).toContain("Files:diffdash.builtin.review")
    })
    expect(
      registry
        .snapshot()
        .projectSurfaceProviders.some(
          ({ ownerExtensionId }) => ownerExtensionId === WALKTHROUGH_EXTENSION_ID,
        ),
    ).toBe(false)
  })

  it("replaces a Review surface provider across same-tick owner turnover", async () => {
    const providerExtensionId = TrustedExtensionId.make("example.review.provider")
    let childMounts = 0
    let childDisposals = 0
    let providerDisposals = 0
    const registrationTokens: TrustedExtensionRegistrationToken[] = []
    const Provider = ({
      active,
      children,
      registrationToken,
    }: {
      readonly active: boolean
      readonly children: ReactNode
      readonly registrationToken: TrustedExtensionRegistrationToken
    }) => {
      registrationTokens.push(registrationToken)
      useEffect(() => {
        if (!active) return undefined
        return () => {
          providerDisposals += 1
        }
      }, [active])
      return <section data-provider-active={active}>{children}</section>
    }
    const extension: TrustedBuiltInExtension = {
      id: providerExtensionId,
      projectSurfaceProviders: [
        {
          id: TrustedExtensionContributionId.make("example.review.provider.slot"),
          order: 100,
          surface: "review",
          component: Provider,
        },
      ],
    }
    const registry = Result.getOrThrow(makeTrustedExtensionRegistry([reviewExtension, extension]))
    const Child = () => {
      useEffect(() => {
        childMounts += 1
        return () => {
          childDisposals += 1
        }
      }, [])
      return <output>Review child</output>
    }
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      <TrustedExtensionRegistryProvider extensions={[]} registry={registry}>
        <PersistentReviewSurfaceProviders>
          <Child />
        </PersistentReviewSurfaceProviders>
      </TrustedExtensionRegistryProvider>,
    )

    await vi.waitFor(() => expect(childMounts).toBe(1))
    expect(registry.unregister(providerExtensionId)).toBe(true)
    Result.getOrThrow(registry.register(extension))
    await vi.waitFor(() => expect(providerDisposals).toBe(1))
    await vi.waitFor(() => expect(childMounts).toBe(2))
    expect(childDisposals).toBe(1)
    expect(registrationTokens.at(-1)).not.toBe(registrationTokens[0])
  })

  it("replaces a project provider across same-tick owner turnover", async () => {
    const extensionId = TrustedExtensionId.make("example.project.provider")
    let childMounts = 0
    let childDisposals = 0
    let providerDisposals = 0
    const registrationTokens: TrustedExtensionRegistrationToken[] = []
    const Provider = ({
      active,
      children,
      registrationToken,
    }: {
      readonly active: boolean
      readonly children: ReactNode
      readonly registrationToken: TrustedExtensionRegistrationToken
    }) => {
      registrationTokens.push(registrationToken)
      useEffect(() => {
        if (!active) return undefined
        return () => {
          providerDisposals += 1
        }
      }, [active])
      return children
    }
    const extension: TrustedBuiltInExtension = {
      id: extensionId,
      projectProviders: [
        {
          id: TrustedExtensionContributionId.make("example.project.provider.slot"),
          order: 100,
          component: Provider,
        },
      ],
    }
    const registry = Result.getOrThrow(makeTrustedExtensionRegistry([extension]))
    const Child = () => {
      useEffect(() => {
        childMounts += 1
        return () => {
          childDisposals += 1
        }
      }, [])
      return <output>Project child</output>
    }
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      <TrustedExtensionRegistryProvider extensions={[]} registry={registry}>
        <ProjectProviderHarness>
          <Child />
        </ProjectProviderHarness>
      </TrustedExtensionRegistryProvider>,
    )

    await vi.waitFor(() => expect(childMounts).toBe(1))
    expect(registry.unregister(extensionId)).toBe(true)
    Result.getOrThrow(registry.register(extension))
    await vi.waitFor(() => expect(providerDisposals).toBe(1))
    await vi.waitFor(() => expect(childMounts).toBe(2))
    expect(childDisposals).toBe(1)
    expect(registrationTokens.at(-1)).not.toBe(registrationTokens[0])
  })

  it("replaces a retained project surface across same-tick owner turnover", async () => {
    let mounts = 0
    let disposals = 0
    const Surface = () => {
      useEffect(() => {
        mounts += 1
        return () => {
          disposals += 1
        }
      }, [])
      return <output>Project surface</output>
    }
    const extension: TrustedBuiltInExtension = {
      ...reviewExtension,
      projectSurfaces: (reviewExtension.projectSurfaces ?? []).map((surface) => ({
        ...surface,
        keepMountedAfterVisit: true,
        component: Surface,
      })),
    }
    const registry = Result.getOrThrow(makeTrustedExtensionRegistry([extension]))
    const SurfaceHarness = () => {
      const { projectSurfaces } = useTrustedExtensionRegistry()
      return <RegisteredProjectSurface contributions={projectSurfaces} surface="review" />
    }
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      <TrustedExtensionRegistryProvider extensions={[]} registry={registry}>
        <SurfaceHarness />
      </TrustedExtensionRegistryProvider>,
    )

    await vi.waitFor(() => expect(mounts).toBe(1))
    expect(registry.unregister(REVIEW_EXTENSION_ID)).toBe(true)
    Result.getOrThrow(registry.register(extension))
    await vi.waitFor(() => expect(mounts).toBe(2))
    expect(disposals).toBe(1)
  })

  it.each([
    {
      activeLabel: "Review",
      activeText: "Active Review surface",
      fallbackText: "Active Code surface",
      fallbackActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
      fallbackSurface: "code" as const,
      projectWorkspaceState: undefined,
      removedExtensionId: REVIEW_EXTENSION_ID,
    },
    {
      activeLabel: "Code",
      activeText: "Active Code surface",
      fallbackText: "Active Review surface",
      fallbackActivity: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
      fallbackSurface: "review" as const,
      projectWorkspaceState: ProjectWorkspaceState.make({
        projectId: ReviewProjectId.make("repo-1"),
        activeSurface: "code",
        activeActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
        navigation: {
          contributionId: codeNavigationContribution.id,
          location: createDefaultCodeNavigationState(ReviewProjectId.make("repo-1")),
        },
        updatedAt: "2026-08-25T00:00:00.000Z",
      }),
      removedExtensionId: CODE_EXTENSION_ID,
    },
  ])("repairs removed active $activeLabel to another project destination with usable history", async ({
    activeText,
    fallbackText,
    fallbackActivity,
    fallbackSurface,
    projectWorkspaceState,
    removedExtensionId,
  }) => {
    const disposeProjectSession = vi.spyOn(ProjectSession.prototype, "dispose")
    const calls = installDiffDashApi(
      projectWorkspaceState === undefined ? {} : { projectWorkspaceState },
    )
    const disposals = { code: 0, review: 0 }
    const codeResourceAcquisitions = { ready: 0, stale: 0 }
    const ReviewSurface = () => {
      useEffect(
        () => () => {
          disposals.review += 1
        },
        [],
      )
      return <output>Active Review surface</output>
    }
    const CodeSurface = () => {
      const { workspaceMounted } = useCodeNavigationController()
      useEffect(() => {
        if (workspaceMounted) codeResourceAcquisitions.ready += 1
        else codeResourceAcquisitions.stale += 1
        return () => {
          disposals.code += 1
        }
      }, [workspaceMounted])
      return <output>Active Code surface</output>
    }
    const extensions = trustedBuiltInExtensions.map((extension): TrustedBuiltInExtension => {
      if (extension.id === REVIEW_EXTENSION_ID) {
        return {
          ...extension,
          projectSurfaces: (reviewExtension.projectSurfaces ?? []).map((surface) => ({
            ...surface,
            component: ReviewSurface,
          })),
        }
      }
      if (extension.id === CODE_EXTENSION_ID) {
        return {
          ...extension,
          projectSurfaces: (codeExtension.projectSurfaces ?? []).map((surface) => ({
            ...surface,
            component: CodeSurface,
          })),
        }
      }
      return extension
    })
    const registry = Result.getOrThrow(makeTrustedExtensionRegistry(extensions))
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(<App extensions={[]} registry={registry} />)

    const projectButton = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open project fungsi/diffdash"]',
      )
      expect(button).not.toBeNull()
      if (button === null) throw new Error("Project button is unavailable")
      return button
    })
    projectButton.click()
    await vi.waitFor(() => expect(container.textContent).toContain(activeText))

    const workbenchContent = container.querySelector("[data-workbench-content]")
    expect(workbenchContent).not.toBeNull()
    const observedWorkbenchFrames: string[] = []
    const workbenchObserver = new MutationObserver(() => {
      observedWorkbenchFrames.push(workbenchContent?.textContent ?? "")
    })
    if (workbenchContent !== null) {
      workbenchObserver.observe(workbenchContent, {
        childList: true,
        characterData: true,
        subtree: true,
      })
    }
    expect(registry.unregister(removedExtensionId)).toBe(true)
    await vi.waitFor(() => expect(container.textContent).toContain(fallbackText))
    await Promise.resolve()
    workbenchObserver.disconnect()
    expect(container.textContent).not.toContain(activeText)
    expect(observedWorkbenchFrames.length).toBeGreaterThan(0)
    expect(
      observedWorkbenchFrames.every(
        (frame) => frame.includes(activeText) || frame.includes(fallbackText),
      ),
    ).toBe(true)
    expect(removedExtensionId === REVIEW_EXTENSION_ID ? disposals.review : disposals.code).toBe(1)
    expect(codeResourceAcquisitions.stale).toBe(0)
    expect(codeResourceAcquisitions.ready).toBe(1)
    expect(disposeProjectSession).toHaveBeenCalledTimes(
      removedExtensionId === REVIEW_EXTENSION_ID ? 1 : 0,
    )
    await vi.waitFor(() =>
      expect(calls.saveProjectWorkspace).toHaveBeenLastCalledWith(
        expect.objectContaining({
          activeSurface: fallbackSurface,
          activeActivity: fallbackActivity,
          navigation: expect.objectContaining({}),
        }),
      ),
    )

    const back = container.querySelector<HTMLButtonElement>("[data-workbench-back]")
    expect(back).not.toBeNull()
    back?.click()
    await vi.waitFor(() => expect(container.textContent).not.toContain(fallbackText))
    const forward = container.querySelector<HTMLButtonElement>("[data-workbench-forward]")
    expect(forward).not.toBeNull()
    forward?.click()
    await vi.waitFor(() => expect(container.textContent).toContain(fallbackText))
  })

  it("repairs an unavailable project owner to the required Home-owned component", async () => {
    installDiffDashApi()
    const registry = Result.getOrThrow(makeTrustedExtensionRegistry(trustedBuiltInExtensions))
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(<App extensions={[]} registry={registry} />)

    const projectButton = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open project fungsi/diffdash"]',
      )
      expect(button).not.toBeNull()
      return button
    })
    projectButton?.click()
    await vi.waitFor(() =>
      expect(
        container.querySelector('button[aria-label="Reviews"][aria-pressed="true"]'),
      ).not.toBeNull(),
    )

    expect(registry.unregister(REVIEW_EXTENSION_ID)).toBe(true)
    await vi.waitFor(() =>
      expect(
        container.querySelector('button[aria-label="Code"][aria-pressed="true"]'),
      ).not.toBeNull(),
    )
    expect(registry.unregister(CODE_EXTENSION_ID)).toBe(true)

    await vi.waitFor(() => expect(container.querySelector("[data-home-layout]")).not.toBeNull())
    expect(
      container.querySelector<HTMLInputElement>(
        'input[placeholder="Search local and hosted projects"]',
      ),
    ).not.toBeNull()
    const [home] = registry.snapshot().globalNavigation
    expect(home).toBeDefined()
    expect(home?.component).toBeTypeOf("function")
    expect(home === undefined ? true : registry.unregister(home.ownerExtensionId)).toBe(false)
    expect(container.querySelector("[data-home-layout]")).not.toBeNull()
  })

  it("boots without Code and opens through Review's project-opening capability", async () => {
    installDiffDashApi()
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      <App
        extensions={trustedBuiltInExtensions.filter(
          (extension) =>
            extension.id !== CODE_EXTENSION_ID && extension.id !== REVIEW_COMMENTS_EXTENSION_ID,
        )}
      />,
    )

    const projectButton = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open project fungsi/diffdash"]',
      )
      expect(button).not.toBeNull()
      return button
    })
    projectButton?.click()

    await vi.waitFor(() => {
      expect(
        container.querySelector('button[aria-label="Reviews"][aria-pressed="true"]'),
      ).not.toBeNull()
      expect(container.querySelector('button[aria-label="Code"]')).toBeNull()
    })
  })

  it("cold-boots Code-only with project opening and persistence but no Review commands", async () => {
    const calls = installDiffDashApi({
      projectWorkspaceState: ProjectWorkspaceState.make({
        projectId: ReviewProjectId.make("repo-1"),
        activeSurface: "review",
        activeActivity: PROJECT_WORKSPACE_REVIEWS_ACTIVITY_ID,
        navigation: {
          contributionId: reviewNavigationContribution.id,
          location: encodeReviewNavigationState({ selectedReview: Option.none() }),
        },
        updatedAt: "2026-08-25T00:00:00.000Z",
      }),
    })
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(
      <App
        extensions={trustedBuiltInExtensions.filter(
          (extension) =>
            extension.id !== REVIEW_EXTENSION_ID &&
            extension.id !== REVIEW_COMMENTS_EXTENSION_ID &&
            extension.id !== WALKTHROUGH_EXTENSION_ID,
        )}
      />,
    )

    const projectButton = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open project fungsi/diffdash"]',
      )
      expect(button).not.toBeNull()
      return button
    })
    projectButton?.click()

    await vi.waitFor(() =>
      expect(
        container.querySelector('button[aria-label="Code"][aria-pressed="true"]'),
      ).not.toBeNull(),
    )
    expect(container.querySelector('button[aria-label="Reviews"]')).toBeNull()
    expect(calls.getProjectWorkspace).toHaveBeenCalled()
    expect(calls.openProject).not.toHaveBeenCalled()
    expect(calls.saveProjectWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        activeSurface: "code",
        activeActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
        navigation: expect.objectContaining({ contributionId: codeNavigationContribution.id }),
      }),
    )
    container.querySelector<HTMLButtonElement>("[data-workbench-command-center]")?.click()
    await Promise.resolve()
    expect(
      container.querySelector<HTMLDialogElement>('dialog[aria-label="Go anywhere"]')?.textContent ??
        "",
    ).not.toContain("Request review flow")
    calls.openPullRequest(51)
    await Promise.resolve()
    expect(calls.openProject).not.toHaveBeenCalled()
  })

  it("forgets a visited Code generation until the replacement is navigated", async () => {
    installDiffDashApi({
      projectWorkspaceState: ProjectWorkspaceState.make({
        projectId: ReviewProjectId.make("repo-1"),
        activeSurface: "code",
        activeActivity: PROJECT_WORKSPACE_CODE_ACTIVITY_ID,
        navigation: {
          contributionId: codeNavigationContribution.id,
          location: createDefaultCodeNavigationState(ReviewProjectId.make("repo-1")),
        },
        updatedAt: "2026-08-25T00:00:00.000Z",
      }),
    })
    let mounts = 0
    let disposals = 0
    let staleAcquisitions = 0
    const CodeSurface = () => {
      const { workspaceMounted } = useCodeNavigationController()
      useEffect(() => {
        if (!workspaceMounted) return undefined
        mounts += 1
        return () => {
          disposals += 1
        }
      }, [workspaceMounted])
      if (!workspaceMounted) {
        staleAcquisitions += 1
        throw new Error("Code surface acquired before its navigation generation was restored")
      }
      return <output>Generation-aware Code surface</output>
    }
    const replacementCodeExtension: TrustedBuiltInExtension = {
      ...codeExtension,
      projectSurfaces: (codeExtension.projectSurfaces ?? []).map((surface) => ({
        ...surface,
        component: CodeSurface,
      })),
    }
    const extensions = trustedBuiltInExtensions.map((extension) =>
      extension.id === CODE_EXTENSION_ID ? replacementCodeExtension : extension,
    )
    const registry = Result.getOrThrow(makeTrustedExtensionRegistry(extensions))
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    root.render(<App extensions={[]} registry={registry} />)

    const projectButton = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open project fungsi/diffdash"]',
      )
      expect(button).not.toBeNull()
      if (button === null) throw new Error("Project button is unavailable")
      return button
    })
    projectButton.click()
    await vi.waitFor(() => expect(mounts).toBe(1))

    expect(registry.unregister(CODE_EXTENSION_ID)).toBe(true)
    Result.getOrThrow(registry.register(replacementCodeExtension))

    await vi.waitFor(() =>
      expect(
        container.querySelector('button[aria-label="Reviews"][aria-pressed="true"]'),
      ).not.toBeNull(),
    )
    expect(disposals).toBe(1)
    expect(mounts).toBe(1)
    expect(staleAcquisitions).toBe(0)
    expect(container.textContent).not.toContain("Generation-aware Code surface")

    const codeButton = container.querySelector<HTMLButtonElement>('button[aria-label="Code"]')
    expect(codeButton).not.toBeNull()
    codeButton?.click()
    await vi.waitFor(() => {
      expect(mounts).toBe(2)
      expect(container.textContent).toContain("Generation-aware Code surface")
    })
    expect(staleAcquisitions).toBe(0)
  })
})
