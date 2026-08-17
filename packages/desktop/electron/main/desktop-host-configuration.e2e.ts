import type { DesktopStartupConfiguration } from "./desktop-host-configuration"

const optionalEnvironmentValue = (value: string | undefined): string | null =>
  value === undefined || value.length === 0 ? null : value

const coreHostMode = (value: string | undefined): "auto" | "bun" | "utility" => {
  if (value === undefined || value.length === 0) return "auto"
  if (value === "bun" || value === "utility") return value
  throw new Error("DIFFDASH_E2E_CORE_HOST must be bun or utility")
}

/** Reads E2E-only host behavior from the Playwright launch environment. */
export const makeE2EDesktopStartupConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
): DesktopStartupConfiguration => ({
  coreHostMode: coreHostMode(environment.DIFFDASH_E2E_CORE_HOST),
  hiddenWindow: true,
  updatesDisabled: environment.DIFFDASH_E2E_DISABLE_UPDATES === "1",
  fixtures: {
    agentProviderEnabled: environment.DIFFDASH_E2E_FAKE_AGENT_PROVIDER === "1",
    agentProviderNeverCompletes: environment.DIFFDASH_E2E_FAKE_AGENT_NEVER_COMPLETES === "1",
    gitProvider:
      environment.DIFFDASH_E2E_FAKE_GIT_PROVIDER === "1"
        ? {
            remoteUrl: environment.DIFFDASH_E2E_FAKE_GIT_REMOTE,
            baseRevision: optionalEnvironmentValue(environment.DIFFDASH_E2E_FAKE_GIT_BASE_SHA),
            headRevision: optionalEnvironmentValue(environment.DIFFDASH_E2E_FAKE_GIT_HEAD_SHA),
          }
        : null,
  },
})
