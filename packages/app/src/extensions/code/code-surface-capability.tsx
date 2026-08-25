import type { ReviewRevision } from "@diffdash/domain/review-identity"
import type { RepositoryRelativePath } from "@diffdash/domain/repository-path"
import { createContext, type ReactNode, use } from "react"
import { AISettings } from "@diffdash/domain/ai-settings"
import {
  RendererLayoutSettings,
  ReviewContextPaneWidth,
  ReviewPaneSettings,
  ReviewThreadDetailPaneWidth,
} from "@diffdash/domain/renderer-layout-settings"
import type { ColorScheme } from "@/settings/theme"
import { useSettingsMutation } from "@/settings/use-settings-mutation"
import { useProjectRepositoryCapability } from "../project-repository-capability"

/** Code-owned application environment kept outside generic project surface mechanics. */
export interface CodeSurfaceEnvironment {
  readonly codeThemes: AISettings["codeThemes"]
  readonly colorScheme: ColorScheme
  readonly contextWidth: number
  readonly threadDetailWidth: number
  readonly linkRepository: () => void
  readonly updateContextWidth: (width: number) => void
  readonly updateThreadDetailWidth: (width: number) => void
}

/** Assembles Code settings and repository capabilities beneath the Code surface. */
export const useCodeSurfaceEnvironment = (colorScheme: ColorScheme): CodeSurfaceEnvironment => {
  const settingsMutation = useSettingsMutation()
  const repository = useProjectRepositoryCapability()
  const updatePaneSettings = (
    update: (settings: AISettings["layout"]["review"]) => AISettings["layout"]["review"],
  ) => {
    void settingsMutation
      .update((current) =>
        AISettings.make({
          ...current,
          layout: RendererLayoutSettings.make({ review: update(current.layout.review) }),
        }),
      )
      .catch(() => undefined)
  }
  return {
    codeThemes: settingsMutation.settings.codeThemes,
    colorScheme,
    contextWidth: settingsMutation.settings.layout.review.contextWidth,
    threadDetailWidth: settingsMutation.settings.layout.review.threadDetailWidth,
    linkRepository: () => void repository.link(),
    updateContextWidth: (width) =>
      updatePaneSettings((current) =>
        ReviewPaneSettings.make({
          ...current,
          contextWidth: ReviewContextPaneWidth.make(width),
        }),
      ),
    updateThreadDetailWidth: (width) =>
      updatePaneSettings((current) =>
        ReviewPaneSettings.make({
          ...current,
          threadDetailWidth: ReviewThreadDetailPaneWidth.make(width),
        }),
      ),
  }
}

/** Code-owned semantic state available to activity panes mounted beneath the Code surface. */
export interface CodeSurfaceCapability {
  readonly workspaceRevision: ReviewRevision | null
  readonly selectedPath: RepositoryRelativePath | null
  readonly selectPath: (path: RepositoryRelativePath) => void
}

const CodeSurfaceCapabilityContext = createContext<CodeSurfaceCapability | null>(null)

/** Supplies Code semantics without adding owner-specific fields to generic activity contracts. */
export const CodeSurfaceCapabilityProvider = ({
  capability,
  children,
}: {
  readonly capability: CodeSurfaceCapability
  readonly children: ReactNode
}) => <CodeSurfaceCapabilityContext value={capability}>{children}</CodeSurfaceCapabilityContext>

/** Reads Code semantics for an activity rendered beneath the Code surface. */
export const useCodeSurfaceCapability = (): CodeSurfaceCapability => {
  const capability = use(CodeSurfaceCapabilityContext)
  if (capability === null) throw new Error("Code surface capability is unavailable")
  return capability
}
