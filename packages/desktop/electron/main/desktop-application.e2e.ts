import type { DesktopApplicationComposition } from "./desktop-application"
import { makeE2EDesktopStartupConfiguration } from "./desktop-host-configuration.e2e"
import { resolveDesktopHostConfiguration } from "./desktop-host-configuration"
import { createExternalApplicationRuntime } from "./external-application-runtime"

const e2eCoreEnvironmentNames = [
  "DIFFDASH_E2E_TERMINAL_HINT_DELIVERY",
  "FAKE_CLAUDE_DELAY_MS",
  "FAKE_CLAUDE_RUN_LOG",
  "FAKE_CLAUDE_UNAVAILABLE",
  "FAKE_CLAUDE_WALKTHROUGH_FAILURE",
  "FAKE_CLAUDE_WALKTHROUGH_INVALID",
  "FAKE_CODEX_RUN_LOG",
  "FAKE_CODEX_WALKTHROUGH_LOG",
  "FAKE_PR_BASE_SHA",
  "FAKE_PR_HEAD_SHA",
  "FAKE_REPO_ROOT",
  "FAKE_USE_REAL_GIT",
  "REAL_GIT_PATH",
]

/** Playwright desktop composition with explicitly selected E2E behavior. */
export const e2eDesktopApplicationComposition: DesktopApplicationComposition = {
  createApplicationRuntime: (configuration) =>
    createExternalApplicationRuntime(configuration, e2eCoreEnvironmentNames),
  resolveHostConfiguration: (identity) =>
    resolveDesktopHostConfiguration(identity, makeE2EDesktopStartupConfiguration(process.env)),
}
