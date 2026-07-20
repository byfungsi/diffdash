import type { AppPrerequisites } from "@diffdash/protocol/prerequisites"
import { Check, Loader2, Sparkles } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card"

const GIT_DOCS_URL = "https://git-scm.com/downloads"
const CODING_AGENT_SETUP_MESSAGE =
  "Walkthroughs require an available agent provider. Complete provider setup to enable guided review."

type SetupRequirement = {
  readonly key: string
  readonly title: string
  readonly description: string
  readonly detail: string
  readonly done: boolean
  readonly helpUrl?: string | null
}

/** First-run setup checklist and telemetry preference. */
export const OnboardingScreen = ({
  diagnostics,
  isLoadingDiagnostics,
  status,
  onComplete,
  onInstallDiffDashCli,
  onOpenDocs,
  onRecheck,
}: {
  readonly diagnostics: AppPrerequisites
  readonly isLoadingDiagnostics: boolean
  readonly status: string | null
  readonly onComplete: (telemetryEnabled: boolean) => void
  readonly onInstallDiffDashCli: () => void
  readonly onOpenDocs: (url: string) => void
  readonly onRecheck: () => void
}) => {
  const rows = prerequisiteRows(diagnostics)
  const completedCount = rows.filter((row) => row.done).length
  const [telemetryEnabled, setTelemetryEnabled] = useState(true)

  return (
    <section className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-10 text-sm">
      <div className="mb-6 space-y-3">
        <Badge variant="secondary" className="text-caption w-fit gap-1.5">
          <Sparkles className="size-3" />
          First-run setup
        </Badge>
        <div className="space-y-2">
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight">Set up DiffDash</h1>
          <p className="text-muted-foreground max-w-3xl text-sm leading-6">
            Local reviews only require Git. Hosted providers and coding agents are optional and can
            be configured now or later.
          </p>
        </div>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle>Setup checklist</CardTitle>
          <CardDescription>
            {isLoadingDiagnostics
              ? "Checking your local setup..."
              : `${completedCount} of ${rows.length} requirements ready.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 pt-0">
          {rows.map((row) => (
            <PrerequisiteRow
              key={row.key}
              requirement={row}
              isChecking={isLoadingDiagnostics}
              onInstallDiffDashCli={onInstallDiffDashCli}
              onOpenDocs={onOpenDocs}
            />
          ))}
        </CardContent>
      </Card>

      <div className="bg-card mt-4 flex items-start gap-3 rounded-xl border p-4 shadow-xs">
        <input
          id="anonymous-telemetry"
          type="checkbox"
          checked={telemetryEnabled}
          className="border-input accent-primary mt-0.5 size-4 rounded"
          onChange={(event) => setTelemetryEnabled(event.target.checked)}
        />
        <label htmlFor="anonymous-telemetry" className="cursor-pointer space-y-1">
          <span className="block text-sm font-medium">Share anonymous usage data</span>
          <span className="text-muted-foreground block text-xs leading-5">
            Help improve DiffDash. We never collect source code, repository details, prompts, or
            personal information. You can also set <code>telemetryEnabled</code> to false in
            <code> ~/.config/diffdash/settings.json</code> and restart DiffDash.
          </span>
        </label>
      </div>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-muted-foreground text-xs">
          {status ?? "You can continue now and finish setup later from Home."}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onRecheck} disabled={isLoadingDiagnostics}>
            {isLoadingDiagnostics ? <Loader2 className="size-3 animate-spin" /> : null}
            Recheck
          </Button>
          <Button onClick={() => onComplete(telemetryEnabled)}>Continue to DiffDash</Button>
        </div>
      </div>
    </section>
  )
}

/** Compact missing-prerequisites card displayed on Home after onboarding. */
export const SetupBanner = ({
  diagnostics,
  status,
  onInstallDiffDashCli,
  onOpenDocs,
  onRecheck,
}: {
  readonly diagnostics: AppPrerequisites
  readonly status: string | null
  readonly onInstallDiffDashCli: () => void
  readonly onOpenDocs: (url: string) => void
  readonly onRecheck: () => void
}) => {
  const missingRows = missingPrerequisiteRows(diagnostics)

  return (
    <Card className="border-primary/20 bg-primary/5 py-4 shadow-xs">
      <CardContent className="grid gap-4 px-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div className="space-y-3">
          <div>
            <div className="font-semibold">Finish setup</div>
            <p className="text-muted-foreground mt-1 text-xs leading-5">
              Complete these items to unlock the full DiffDash workflow.
            </p>
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            {missingRows.map((row) => (
              <PrerequisiteRow
                key={row.key}
                requirement={row}
                compact
                onInstallDiffDashCli={onInstallDiffDashCli}
                onOpenDocs={onOpenDocs}
              />
            ))}
          </div>
          {status !== null ? <div className="text-muted-foreground text-xs">{status}</div> : null}
        </div>
        <Button variant="outline" onClick={onRecheck}>
          Recheck
        </Button>
      </CardContent>
    </Card>
  )
}

/** Returns setup requirements that still need user action. */
export const missingPrerequisiteRows = (diagnostics: AppPrerequisites) =>
  prerequisiteRows(diagnostics).filter((row) => !row.done)

const PrerequisiteRow = ({
  compact = false,
  isChecking = false,
  requirement,
  onInstallDiffDashCli,
  onOpenDocs,
}: {
  readonly compact?: boolean
  readonly isChecking?: boolean
  readonly requirement: SetupRequirement
  readonly onInstallDiffDashCli: () => void
  readonly onOpenDocs: (url: string) => void
}) => (
  <div
    className={`bg-background grid gap-3 rounded-2xl border p-3 ${compact ? "md:grid-cols-[1fr_auto]" : "md:grid-cols-[1fr_auto] md:items-center"}`}
  >
    <div className="flex min-w-0 gap-3">
      <span
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
          requirement.done
            ? "border-review-success bg-review-success/10 text-review-success"
            : "border-primary/30 bg-primary/10 text-primary"
        }`}
      >
        {isChecking ? (
          <Loader2 className="size-3 animate-spin" />
        ) : requirement.done ? (
          <Check className="size-3" />
        ) : (
          "!"
        )}
      </span>
      <div className="min-w-0">
        <div className="font-medium">{requirement.title}</div>
        <p className="text-muted-foreground mt-1 text-xs leading-5">{requirement.description}</p>
        <div className="text-caption text-muted-foreground mt-1">{requirement.detail}</div>
      </div>
    </div>
    <PrerequisiteAction
      requirement={requirement}
      onInstallDiffDashCli={onInstallDiffDashCli}
      onOpenDocs={onOpenDocs}
    />
  </div>
)

const PrerequisiteAction = ({
  requirement,
  onInstallDiffDashCli,
  onOpenDocs,
}: {
  readonly requirement: SetupRequirement
  readonly onInstallDiffDashCli: () => void
  readonly onOpenDocs: (url: string) => void
}) => {
  if (requirement.done) {
    return (
      <Badge variant="secondary" className="self-start">
        Ready
      </Badge>
    )
  }
  if (requirement.helpUrl !== undefined && requirement.helpUrl !== null) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onOpenDocs(requirement.helpUrl ?? "")}
      >
        Setup docs
      </Button>
    )
  }
  if (requirement.key === "git-cli") {
    return (
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onOpenDocs(GIT_DOCS_URL)}
      >
        Git docs
      </Button>
    )
  }
  if (requirement.key === "diffdash-cli") {
    return (
      <Button size="sm" className="self-start" onClick={onInstallDiffDashCli}>
        Install in PATH
      </Button>
    )
  }
  return null
}

const prerequisiteRows = (diagnostics: AppPrerequisites): readonly SetupRequirement[] => [
  {
    key: "git-cli",
    title: "Git installed",
    description: "DiffDash uses git for local repository detection and local diff reviews.",
    detail: diagnostics.gitInstalled ? "git is available in PATH." : "git was not found in PATH.",
    done: diagnostics.gitInstalled,
  },
  ...diagnostics.setupRequirements.map((requirement) => ({
    key: requirement.key,
    title: requirement.title,
    description: requirement.description,
    detail: requirement.detail,
    done: requirement.ready,
    helpUrl: requirement.helpUrl,
  })),
  {
    key: "coding-agent",
    title: "Coding agent installed",
    description: CODING_AGENT_SETUP_MESSAGE,
    detail: installedCodingAgentDetail(diagnostics.installedCodingAgents),
    done: diagnostics.codingAgentInstalled,
  },
  {
    key: "diffdash-cli",
    title: "DiffDash CLI installed in PATH",
    description: "Install the diffdash command so you can open local reviews from any terminal.",
    detail: diagnostics.diffDashCliInPath
      ? (diagnostics.diffDashCliPath ?? "diffdash is available in PATH.")
      : diagnostics.diffDashCliInstalled
        ? `${diagnostics.diffDashCliPath} exists, but its directory is not in PATH.`
        : "diffdash was not found in PATH.",
    done: diagnostics.diffDashCliInPath,
  },
]

const installedCodingAgentDetail = (agents: readonly string[]) => {
  if (agents.length === 0) return "No supported coding agent was found in PATH."
  return `Detected ${agents.length} available agent provider${agents.length === 1 ? "" : "s"}.`
}
